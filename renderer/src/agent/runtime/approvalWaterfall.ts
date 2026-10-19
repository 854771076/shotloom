import { settingsStore } from '@/store/settingsStore';
import {
  TURN_BOUNDARY_KEY,
  commitProjectionEvent,
  createSessionProjectionHost,
  projectionView,
  type ProjectionHost,
  type TurnBoundaryState,
} from '@/store/projectProjections';
import { createAgentInteraction, type AgentRunContinuation } from './runStore';
import { waitForAgentApproval, type AgentApprovalResolution } from './runtimeInteractions';
import type { AgentToolContext, JsonObject } from '../core/types';

/**
 * 审批（user-approval）的唯一服务层实现。
 *
 * 参考实现把「问不问」「在哪问」「问完记什么」收进一个服务，而不是散在调用点；
 * Shotloom 沿用同样的三条承重规则：
 *
 * 1. `'never'` 策略在服务层就地判定——它不依赖任何监听器、也不依赖注册顺序，
 *    因此即使有人后注册了一个更靠前的拦截器，也无法让一次注定被拒绝的提问被放行。
 * 2. 回合边界前置检查：审计对（asked + decided）必须落在一次已开启的模型回合内，
 *    否则它和崩溃尾巴无法区分。没有开启回合时失败关闭（`unavailable`），且不写半截审计对。
 * 3. 提问失败一律失败关闭：监听器抛异常、确认被替换、非词表返回值都归一化为 `unavailable`，
 *    绝不让调用方静默放行。
 *
 * 审批服务的会话状态（当前回合边界）挂在 `AgentToolContext.state` 里，与工具管道同一份；
 * 它是一次运行的运行态，不进项目 JSON。
 */
export type ApprovalPolicy = 'ask' | 'never';
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';

/** 会话投影宿主在 `context.state` 里的键；回合边界投影读它。 */
const SESSION_PROJECTION_HOST_KEY = 'sessionProjectionHost';
/** 确认卡有效期；与既有工具确认保持一致（过期即失败关闭）。 */
const APPROVAL_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

/**
 * 当前生效的审批策略。默认 `'ask'`（可以问，但没有可用答者时同样失败关闭）；
 * `'never'` 是无人值守/确定性的立场：需要审批的操作一律自动拒绝，绝不打扰任何人。
 */
export function resolveApprovalPolicy(): ApprovalPolicy {
  return settingsStore.agentApprovalPolicy === 'never' ? 'never' : 'ask';
}

function isSessionHost(value: unknown): value is ProjectionHost {
  const host = value as ProjectionHost | undefined;
  return !!host && typeof host === 'object' && host.scope === 'session' && host.cells instanceof Map;
}

/** 取得（必要时建立）本次运行的会话投影宿主。 */
export function ensureSessionProjectionHost(context: AgentToolContext): ProjectionHost {
  const existing = context.state.get(SESSION_PROJECTION_HOST_KEY);
  if (isSessionHost(existing)) return existing;
  const host = createSessionProjectionHost();
  context.state.set(SESSION_PROJECTION_HOST_KEY, host);
  return host;
}

/**
 * 开启一次模型回合。回合是审计对的提交边界：审批只能发生在开启区间内。
 * 同号回合重复开启是幂等空操作（投影自身也会抑制重复的等价事件）。
 */
export function openAgentTurn(context: AgentToolContext, turn: number): void {
  const host = ensureSessionProjectionHost(context);
  const current = projectionView<TurnBoundaryState>(host, TURN_BOUNDARY_KEY);
  if (current?.open === true && current.turn === turn) return;
  commitProjectionEvent(host, 'turn/start', { turn });
}

/** 闭合当前回合；没有开启的回合时是空操作。 */
export function closeAgentTurn(context: AgentToolContext): void {
  const existing = context.state.get(SESSION_PROJECTION_HOST_KEY);
  if (!isSessionHost(existing)) return;
  const current = projectionView<TurnBoundaryState>(existing, TURN_BOUNDARY_KEY);
  if (current?.open !== true) return;
  commitProjectionEvent(existing, 'turn/end', {});
}

/** 当前是否有开启的回合（审批前置检查读它）。 */
export function hasOpenAgentTurn(context: AgentToolContext): boolean {
  const existing = context.state.get(SESSION_PROJECTION_HOST_KEY);
  if (!isSessionHost(existing)) return false;
  return projectionView<TurnBoundaryState>(existing, TURN_BOUNDARY_KEY)?.open === true;
}

export interface ApprovalPrompt {
  context: AgentToolContext;
  /** 交互回执里记录的续跑上下文（由工具管道构造，审批服务原样保存）。 */
  continuation: AgentRunContinuation;
  stepId: string;
  toolCallId: string;
  toolName: string;
  title: string;
  actionCount: number;
  /** 'decision' 只问是否继续；'step' 是工具自己产出的待确认步骤，批准后取它的结果。 */
  mode: 'decision' | 'step';
  pendingArgs?: JsonObject;
}

export interface ApprovalResolution {
  outcome: ApprovalOutcome;
  /** 用户裁决的原始回执；策略直接拒绝或回合前置检查失败时为 null（没有派发确认）。 */
  resolution: AgentApprovalResolution | null;
  /** 失败时给调用方/模型的可读原因；放行时为空串。 */
  reason: string;
}

function decidedEvent(
  context: AgentToolContext,
  interactionId: string,
  stepId: string,
  outcome: ApprovalOutcome,
): JsonObject & { type: string } {
  return {
    type: 'approval_decided',
    turnId: context.turnId,
    interactionId,
    stepId,
    outcome,
    createdAt: new Date().toISOString(),
  };
}

/**
 * 请求一次审批。调用方（工具管道）只消费归一化后的结果，不再各自解读确认卡回执。
 *
 * 顺序是承重的：回合前置检查 → 写 `approval_asked` → 服务层判 `'never'`（拒绝，不派发）
 * → 派发确认 → 写 `approval_decided`。任何一个确认失败都归一化为失败关闭的结局。
 */
export async function requestApproval(prompt: ApprovalPrompt): Promise<ApprovalResolution> {
  const { context } = prompt;
  const policy = resolveApprovalPolicy();
  // 回合边界前置检查：没有开启的回合就不写任何审计事件，直接失败关闭。
  if (!hasOpenAgentTurn(context)) {
    return {
      outcome: 'unavailable',
      resolution: null,
      reason: '审批必须发生在一次已开启的模型回合内；当前没有开启的回合，已按失败关闭拒绝。',
    };
  }
  const interactionId = `${context.requestId}:tool_confirmation:${prompt.stepId}`;
  context.emit({
    type: 'approval_asked',
    turnId: context.turnId,
    interactionId,
    toolCallId: prompt.toolCallId,
    toolName: prompt.toolName,
    stepId: prompt.stepId,
    policy,
    createdAt: new Date().toISOString(),
  });
  // 'never' 就在这里决定：不创建交互、不发 interaction_requested，确认卡永远不会出现。
  if (policy === 'never') {
    context.emit(decidedEvent(context, interactionId, prompt.stepId, 'rejected'));
    return {
      outcome: 'rejected',
      resolution: null,
      reason: `当前会话已禁用审批（approval policy = never），需要审批的「${prompt.title}」被自动拒绝。`,
    };
  }

  createAgentInteraction({
    id: interactionId,
    runId: context.requestId,
    conversationId: context.conversationId,
    projectKey: context.projectKey,
    kind: 'tool_confirmation',
    payload: {
      toolCallId: prompt.toolCallId,
      toolName: prompt.toolName,
      stepId: prompt.stepId,
      title: prompt.title,
      actionCount: prompt.actionCount,
      mode: prompt.mode,
      ...(prompt.pendingArgs ? { pendingArgs: prompt.pendingArgs } : {}),
    },
    continuation: prompt.continuation,
    expiresAt: new Date(Date.now() + APPROVAL_TTL_MS).toISOString(),
  });
  context.emit({
    type: 'interaction_requested',
    interactionId,
    kind: 'tool_confirmation',
    toolCallId: prompt.toolCallId,
    toolName: prompt.toolName,
    stepId: prompt.stepId,
    title: prompt.title,
    actionCount: prompt.actionCount,
    ...(prompt.pendingArgs ? { pendingArgs: prompt.pendingArgs } : {}),
    createdAt: new Date().toISOString(),
  });

  let resolution: AgentApprovalResolution;
  try {
    resolution = await waitForAgentApproval(context.requestId, prompt.stepId, context.signal);
  } catch (cause) {
    const cancelled = cause instanceof Error && cause.name === 'AbortError';
    const outcome: ApprovalOutcome = cancelled ? 'cancelled' : 'unavailable';
    context.emit({
      type: 'interaction_resolved', interactionId, kind: 'tool_confirmation',
      toolCallId: prompt.toolCallId, stepId: prompt.stepId, approved: false,
      createdAt: new Date().toISOString(),
    });
    context.emit(decidedEvent(context, interactionId, prompt.stepId, outcome));
    // 中断要原样向上传递：运行中止走的是取消路径，不能伪装成一次普通的"用户拒绝"。
    if (cancelled) throw cause;
    return {
      outcome,
      resolution: null,
      reason: `确认失败关闭：${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }

  const approved = resolution.approved === true;
  context.emit({
    type: 'interaction_resolved', interactionId, kind: 'tool_confirmation',
    toolCallId: prompt.toolCallId, stepId: prompt.stepId, approved,
    createdAt: new Date().toISOString(),
  });
  const outcome: ApprovalOutcome = approved ? 'allowed-once' : 'rejected';
  context.emit(decidedEvent(context, interactionId, prompt.stepId, outcome));
  return {
    outcome,
    resolution,
    reason: approved ? '' : (resolution.error || `用户拒绝了「${prompt.title}」`),
  };
}
