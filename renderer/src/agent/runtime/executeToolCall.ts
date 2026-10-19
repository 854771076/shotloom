import { assertAgentProject } from '@/services/agentProjectIdentity';
import { settingsStore } from '@/store/settingsStore';
import { AgentToolInputError, prepareAgentToolCall, findParallelSafeAgentTool } from '../core/toolRegistry';
import { resolveAgentToolPolicy } from '../core/policyEngine';
import type {
  AgentToolContext, AgentToolDefinition, AgentToolEffect, JsonObject, PreparedAgentToolCall,
} from '../core/types';
import { createAgentInteraction } from './runStore';
import { requestApproval } from './approvalWaterfall';
import { waitForAgentApproval } from './runtimeInteractions';
import {
  createLoopGuardState,
  forgetToolCall,
  inspectToolCall,
  loopGuardMessage,
  recordToolCall,
  toolCallFingerprint,
  type LoopGuardState,
} from './loopGuard';
import { buildToolReceipt, receiptChangesProject } from './toolReceipts';
import { markToolCallStarted, ensureStartedToolCallTrace } from '../loop/transcript';
import { describeArgumentChanges, userOverrideNote } from '@/utils/toolArgumentDiff.ts';

/**
 * Agent 工具的唯一执行管道。
 *
 * 权限确认、重复调用拦截、用户改参重校验、回执记账和 tool_start/tool_end 事件只有一份实现。
 * 模型循环不得自行调用 definition.execute，否则会绕过其中任何一层。
 * 对外只有 executeAgentToolCalls 一个入口：一次模型的回合传一批，管道自己决定哪些能并发。
 */
export interface AgentToolRun {
  context: AgentToolContext;
  model: string;
}

export interface AgentToolCallRequest {
  callId: string;
  name: string;
  /**
   * 模型给出的原始 JSON 字符串，不在引擎层先 JSON.parse 再序列化回来：
   * toolRegistry 的 repair 路径（去掉控制字符、补逗号、截取首尾花括号）
   * 只在拿到真实文本时才可能生效。
   */
  argumentsJson: string;
}

function exposeToolCallId(result: unknown, toolCallId: string): Record<string, unknown> {
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    return { ...(result as JsonObject), toolCallId };
  }
  return { value: result, toolCallId };
}

function continuation(run: AgentToolRun, toolCallId: string, toolName: string) {
  const facts = run.context.run;
  return {
    toolCallId, toolName, model: run.model,
    conversationId: run.context.conversationId, attachments: run.context.attachments,
    nodeMentions: [], successfulToolCallIds: [...facts.successfulToolCallIds],
    toolReceipts: [...facts.toolReceipts.values()],
    hasAppliedActions: facts.hasAppliedActions,
    activeProductionPlanId: facts.activeProductionPlanId || undefined,
    lastActionError: String(run.context.state.get('lastActionError') || ''), modelRounds: 0,
  };
}

const LOOP_GUARD_STATE_KEY = 'loopGuard';

/** 工具默认时长上限；需要等待用户或真实渲染的工具自己声明 0 退出这个上限。 */
export const DEFAULT_AGENT_TOOL_TIMEOUT_MS = 120_000;

/**
 * 给 execute 加上限：一个卡死的本地调用不能让整轮停在"正在处理"，而看门狗只提示不中止。
 *
 * 超时不等于"没有效果"：Promise 杀不掉，被放弃的调用可能仍在后台跑并且已经改过项目。
 * 因此写类工具的回执只能说结果未知，并要求模型先用只读工具核验，而不是把它当成一次干净的重试点；
 * 只读与内部记账按权限层的分类判定不会改动项目，才可以直接重调。
 */
function withToolTimeout<T>(definition: AgentToolDefinition, effect: AgentToolEffect, run: Promise<T>): Promise<T | JsonObject> {
  const timeoutMs = definition.timeoutMs ?? DEFAULT_AGENT_TOOL_TIMEOUT_MS;
  if (!(timeoutMs > 0)) return run;
  const impact = effect === 'read' || effect === 'agent_state_write'
    ? `这次调用按权限分类（${effect}）不会改动项目，需要信息可以直接重新调用。`
    : '它可能仍在后台执行并且已经改动项目。先用只读工具核验当前真实状态再决定是否重做，不要直接重复这次调用。';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<JsonObject>((resolve) => {
    timer = setTimeout(() => resolve({
      success: false,
      timedOut: true,
      error: `工具 ${definition.id} 超过 ${(timeoutMs / 1000).toFixed(timeoutMs >= 1_000 ? 0 : 1)} 秒没有返回，本次结果未知。${impact}`,
    }), timeoutMs);
  });
  // race 会同时给两个 Promise 挂上处理函数，被放弃的那个之后失败也不会变成未处理的 rejection。
  return Promise.race([run, deadline]).finally(() => clearTimeout(timer));
}

interface GuardedToolCall {
  reject: boolean;
  message: string;
  /** 实际要执行的输入：用户改过参数时是重新校验后的新输入。 */
  input: JsonObject;
  overrideNote: string;
}

/**
 * 同一轮内用实质上相同的参数反复调用同一个工具时，先请用户裁决再执行。
 * 复用现有的 tool_confirmation 交互管道：面板、持久化、过期与中断处理都已具备。
 * `mode: 'decision'` 表示这里没有暂存的画布步骤，只请求"是否继续"。
 */
async function reviewRepeatedToolCall(
  run: AgentToolRun,
  context: AgentToolContext,
  callId: string,
  toolName: string,
  toolInput: JsonObject,
): Promise<GuardedToolCall> {
  const guard = (context.state.get(LOOP_GUARD_STATE_KEY) as LoopGuardState | undefined)
    || createLoopGuardState();
  context.state.set(LOOP_GUARD_STATE_KEY, guard);
  const fingerprint = toolCallFingerprint(toolName, toolInput);
  const { trip, count } = inspectToolCall(guard, fingerprint);
  if (!trip) {
    recordToolCall(guard, fingerprint);
    return { reject: false, message: '', input: toolInput, overrideNote: '' };
  }

  const stepId = `loop:${callId}`;
  const interactionId = `${context.requestId}:tool_confirmation:${stepId}`;
  const title = loopGuardMessage(toolName, count);
  createAgentInteraction({
    id: interactionId, runId: context.requestId, conversationId: context.conversationId,
    projectKey: context.projectKey, kind: 'tool_confirmation',
    payload: {
      toolCallId: callId, toolName, stepId, title, actionCount: 0,
      mode: 'decision', pendingArgs: toolInput,
    },
    continuation: continuation(run, callId, toolName),
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString(),
  });
  context.emit({
    type: 'interaction_requested', interactionId, kind: 'tool_confirmation',
    toolCallId: callId, toolName, stepId, title, actionCount: 0,
    pendingArgs: toolInput,
    createdAt: new Date().toISOString(),
  });
  const resolution = await waitForAgentApproval(context.requestId, stepId, context.signal);
  context.emit({
    type: 'interaction_resolved', interactionId, kind: 'tool_confirmation',
    toolCallId: callId, stepId, approved: resolution.approved,
    createdAt: new Date().toISOString(),
  });
  if (!resolution.approved) {
    // 不清空历史：模型若无视回执继续重试，下一次相同调用会被立即拦下。
    return {
      reject: true,
      message: `${title}。用户已拒绝继续重复调用：请改用不同的工具或实质不同的输入，或停下来向用户确认；不要继续微调参数重试。`,
      input: toolInput,
      overrideNote: '',
    };
  }

  const modified = resolution.modifiedArgs;
  // 以"是否携带"判断有没有改过：用户在编辑器里清空成 {} 是有效修改，不能退回原参数。
  if (!modified) {
    forgetToolCall(guard, fingerprint);
    return { reject: false, message: '', input: toolInput, overrideNote: '' };
  }
  // 用户改过参数：按工具自己的 schema 重新校验，不能绕过注册表直接执行。
  let reprepared;
  try {
    reprepared = prepareAgentToolCall(toolName, JSON.stringify(modified), context);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return {
      reject: true,
      message: `用户修改后的参数未通过校验：${reason}。这次调用没有执行，请向用户说明问题，不要用原参数重试。`,
      input: toolInput,
      overrideNote: '',
    };
  }
  forgetToolCall(guard, toolCallFingerprint(toolName, reprepared.input));
  return {
    reject: false,
    message: '',
    input: reprepared.input,
    overrideNote: userOverrideNote(describeArgumentChanges(toolInput, reprepared.input)),
  };
}

type ToolRejection = 'invalid_input' | 'permission';

/**
 * 调用在真正派发之前就被拒绝：把它作为可恢复的工具结果返回，并留下一条失败步骤。
 *
 * 这类调用从未进入 execute，所以不写开始标记——中断后补写无应答调用时，
 * 它才可以如实说"没有产生任何效果"。
 */
function refusedToolCall(
  context: AgentToolContext,
  call: AgentToolCallRequest,
  reason: ToolRejection,
  issues: string[],
): Record<string, unknown> {
  const error = issues.join('；');
  context.state.set('lastActionError', error);
  context.emit({
    type: 'tool_end', turnId: context.turnId, toolCallId: call.callId,
    toolName: call.name, isError: true, error, rejection: reason,
    toolCallCount: context.run.successfulToolCallIds.size,
    endedAt: new Date().toISOString(),
  });
  return exposeToolCallId({ success: false, rejection: reason, issues, error }, call.callId);
}

/** 单个调用的完整派发；只有下面的批量入口可以调用它。 */
async function executeAgentToolCall(
  run: AgentToolRun,
  call: AgentToolCallRequest,
): Promise<Record<string, unknown>> {
  const base = run.context;
  const context: AgentToolContext = { ...base, turnId: `${base.requestId}:tool:${call.callId}` };
  assertAgentProject(context.projectKey, context.projectInstanceId, context.projectGeneration);
  let prepared: PreparedAgentToolCall;
  try {
    prepared = prepareAgentToolCall(call.name, call.argumentsJson, context);
  } catch (cause) {
    // 参数与可见性校验失败同样是可恢复回执：结构化的 issues 直接交给模型，让它改输入或换工具，
    // 并且必须留下一条失败步骤——否则会留下"模型调用过但界面上什么都没发生"的空洞。
    const issues = cause instanceof AgentToolInputError
      ? cause.issues
      : [cause instanceof Error ? cause.message : String(cause)];
    return refusedToolCall(context, call, 'invalid_input', issues);
  }
  const effect = prepared.definition.resolveEffect?.(prepared.input, context) || prepared.definition.effect;
  // “询问”模式：只对会改写项目/画布/启动媒体生成的关键工具申请审批；
  // 只读与 Agent 内部记账（read / agent_state_write）不打扰用户。
  const policy = resolveAgentToolPolicy(effect, {
    ...context,
    requireApproval: settingsStore.agentShellApproval === 'ask',
  });
  if (policy === 'deny') {
    // 权限与用户设置是代码必须强制的边界，但强制方式是把拒绝作为回执交回模型，
    // 让它改用别的方案或向用户说明，而不是终止整轮。
    return refusedToolCall(context, call, 'permission',
      [`当前用户设置或权限不允许执行 ${prepared.definition.id}（${effect}）`]);
  }
  // 拒绝权限仍优先；但工具自己声明 approvalRequired 时，无论询问/自动模式都要先让用户裁决
  // （计划模式收尾这类单点人工闸口）。审批统一交给服务层：策略、回合边界与审计对只有那一份实现。
  if (policy === 'confirm' || prepared.definition.approvalRequired === true) {
    const title = prepared.definition.title || prepared.definition.id;
    const approval = await requestApproval({
      context,
      continuation: continuation(run, call.callId, prepared.definition.id),
      stepId: `policy:${call.callId}`,
      toolCallId: call.callId,
      toolName: prepared.definition.id,
      title,
      actionCount: 0,
      mode: 'decision',
      pendingArgs: prepared.input,
    });
    if (approval.outcome !== 'allowed-once') {
      throw new Error(approval.reason || `用户拒绝了「${title}」`);
    }
    // 用户在确认时改过参数：按工具自己的 schema 重新校验后执行，而不是用原参数。
    if (approval.resolution?.modifiedArgs) {
      const reprepared = prepareAgentToolCall(call.name, JSON.stringify(approval.resolution.modifiedArgs), context);
      prepared.input = reprepared.input;
    }
  }
  const startedAt = new Date().toISOString();
  context.state.set('activeInteractionId', `${context.requestId}:question:${call.callId}`);
  context.state.set('activeInteractionContinuation', continuation(run, call.callId, prepared.definition.id));
  context.emit({
    type: 'tool_start', turnId: context.turnId, toolCallId: call.callId,
    toolName: prepared.definition.id, effect,
    // 完整参数随事件走：界面展开一步时要能如实展示"这一步到底被喂了什么"，
    // 只有摘要会让失败排查失去依据。runStore 仍只持久化 inputSummary。
    inputSummary: prepared.inputSummary, args: prepared.input, startedAt,
  });
  try {
    // 循环拦截在 execute 之前完成，拒绝时把失败作为普通结果交给既有回执流程处理，
    // 保证 toolReceipts / lastActionError / tool_end 的记账与其它失败路径一致。
    const guarded = await reviewRepeatedToolCall(run, context, call.callId, prepared.definition.id, prepared.input);
    // 只有真的派发下去才算"已开始执行"；等待用户确认时被打断仍然可以原样重试。
    if (!guarded.reject) markToolCallStarted(context, call.callId);
    let result: any = await withToolTimeout(prepared.definition, effect, Promise.resolve(
      guarded.reject
        ? { success: false, rejected: true, repeatedToolCall: true, error: guarded.message }
        : prepared.definition.execute(guarded.input, context),
    ));
    if (guarded.overrideNote && result && typeof result === 'object' && !Array.isArray(result)) {
      // 把用户的手动修改明确告知模型，避免它用原参数再试一遍。
      result = { ...result, userOverrideNote: guarded.overrideNote };
    }
    if (result?.pending === true) {
      const step = result.step || {};
      const stepId = String(step.id || step.stepId || '');
      if (!stepId) throw new Error('待确认工具没有返回稳定 stepId');
      const approval = await requestApproval({
        context,
        continuation: continuation(run, call.callId, prepared.definition.id),
        stepId,
        toolCallId: call.callId,
        toolName: prepared.definition.id,
        title: String(step.title || prepared.definition.title),
        actionCount: Number(step.actionCount || 0),
        mode: 'step',
      });
      result = approval.outcome === 'allowed-once'
        ? approval.resolution?.result
        : { success: false, rejected: true, error: approval.reason || '用户拒绝了本次操作' };
    }
    const receipt = buildToolReceipt(call.callId, prepared.definition.id, effect, result,
      prepared.definition.summarizeResult?.(result));
    context.run.toolReceipts.set(call.callId, receipt);
    if (receiptChangesProject(receipt)) context.run.hasAppliedActions = true;
    if (result?.success !== false) {
      context.run.successfulToolCallIds.add(call.callId);
    } else {
      context.state.set('lastActionError', String(result?.error || '工具执行失败'));
    }
    context.emit({
      type: 'tool_end', turnId: context.turnId, toolCallId: call.callId,
      toolName: prepared.definition.id, isError: result?.success === false,
      error: String(result?.error || ''), receipt,
      toolCallCount: context.run.successfulToolCallIds.size,
      endedAt: new Date().toISOString(),
    });
    return exposeToolCallId(result, call.callId);
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause);
    context.emit({
      type: 'tool_end', turnId: context.turnId, toolCallId: call.callId,
      toolName: prepared.definition.id, isError: true, error, endedAt: new Date().toISOString(),
    });
    throw cause;
  }
}

/**
 * 一次调用的失败按工具结果返回，而不是抛出：模型可以改输入或换工具继续，
 * 不该因为一个可修复的调用失败终止整轮。项目身份变更同样走这条规则，与改动前的循环行为一致。
 */
async function executeSingleToolCall(run: AgentToolRun, call: AgentToolCallRequest): Promise<Record<string, unknown>> {
  try {
    return await executeAgentToolCall(run, call);
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause);
    return { success: false, error };
  }
}

/**
 * 一批调用的派发入口：权限、回执和事件仍然逐个走同一条管道，
 * 只有整批都是并行安全的只读调用时才让它们并发跑，结果按传入顺序返回。
 *
 * 并发条件收窄到只读，是因为两个 execute 同时跑会互相踩会话 state 里读-改-写式的容器，
 * 也可能同时挂在用户确认上。只读工具既不会改项目，按权限层也恒为 allow，因此不会等待；
 * 写工具、需要动态解析 effect 的工具、要确认或被拒绝的调用一律退回逐个串行。
 */
export async function executeAgentToolCalls(
  run: AgentToolRun,
  calls: AgentToolCallRequest[],
): Promise<Record<string, unknown>[]> {
  const requireApproval = settingsStore.agentShellApproval === 'ask';
  const parallel = calls.length > 1 && calls.every((call) => {
    const definition = findParallelSafeAgentTool(call.name, run.context);
    // 并发与否最终仍由唯一的权限判定函数说了算，不能让并行条件自己另写一份规则。
    return !!definition && resolveAgentToolPolicy(definition.effect, { ...run.context, requireApproval }) === 'allow';
  });
  if (!parallel) {
    const results: Record<string, unknown>[] = [];
    for (const call of calls) results.push(await executeSingleToolCall(run, call));
    return results;
  }
  // 派发前把共享容器固定成同一个实例：读-改-写会让后启动的调用覆盖先记录的凭证。
  // 回执与成功计数已经是 run 上的固定字段，这里只剩会话自己的两个容器。
  const state = run.context.state;
  if (!state.has(LOOP_GUARD_STATE_KEY)) state.set(LOOP_GUARD_STATE_KEY, createLoopGuardState());
  ensureStartedToolCallTrace(state);
  return Promise.all(calls.map((call) => executeSingleToolCall(run, call)));
}
