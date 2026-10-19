import { agentDefinition, type AgentDefinition } from '../agents/definitions.ts';
import { buildConcludeTurnInstruction, buildSteeringMessage, buildSubagentPrompt } from '../content/instructions';
import { executeAgentToolCalls } from '../runtime/executeToolCall';
import { closeAgentTurn, openAgentTurn } from '../runtime/approvalWaterfall';
import { receiptChangesProject } from '../runtime/toolReceipts';
import { toolCallFingerprint } from '../runtime/loopGuard';
import type { AgentToolContext, JsonObject } from '../core/types';
import { createLoopBuiltins, type LoopBuiltin } from './builtinTools';
import { serializeToolOutputForTranscript } from './toolOutputSpill';
import { serializeLoopTools, buildLoopRequestBody, type LoopModelPlan } from './modelRequest';
import {
  estimateTextTokens,
  fitTranscript,
  markToolCallStarted,
  type AgentToolCall,
  type ChatContentPart,
  type ChatMessage,
} from './transcript';

/**
 * Shotloom 自研 Agent 循环。
 *
 * 循环控制权在渲染进程：每一步都重新解析该 session 的工具可见集，因此子 Agent 只看得见
 * 自己定义里的工具；模型回复、工具调用与工具结果都按 OpenAI 消息结构进入历史。
 * 这里只负责"问模型 → 执行它选的工具 → 把真实结果喂回去"，业务权限全部由
 * runtime/executeToolCall.ts 强制执行。
 */

export interface AssistantTurn {
  text: string;
  toolCalls: AgentToolCall[];
  finishReason: string;
  responseItems?: Record<string, unknown>[] | undefined;
  /** 模型上报的真实占用；缺失时调用方用估算值兜底。 */
  usage?: { input?: number; output?: number } | undefined;
}

export type LoopModelCaller = (
  body: Record<string, unknown>,
  onTextDelta: (delta: string) => void,
) => Promise<AssistantTurn>;

export interface AgentLoopInput {
  agent?: AgentDefinition;
  context: AgentToolContext;
  plan: LoopModelPlan;
  systemPrompt: string;
  messages: ChatMessage[];
  callModel: LoopModelCaller;
  emit: (event: JsonObject & { type: string }) => void;
  onMessagesChanged?: ((messages: ChatMessage[]) => void) | undefined;
  /**
   * 运行进行中到达的用户补充消息。循环在每一步请求前取空它并作为真实用户消息写进历史，
   * 所以补充指令永远不会落在没有应答的工具调用之后；取用即消费，不重放。
   */
  takeSteeringMessages?: (() => string[]) | undefined;
}

export interface AgentLoopResult {
  reply: string;
  modelRounds: number;
  messages: ChatMessage[];
}

/**
 * 连续多少轮"既没有尝试过新调用、也没有真实改动项目"判定为原地打转。
 * 轮次本身不设上限：合法长任务该一直跑下去，只有完全不推进的循环才该被切断。
 */
export const STALLED_ROUND_LIMIT = 3;

function builtinToRequestTool(builtin: LoopBuiltin) {
  return {
    type: 'function' as const,
    function: { name: builtin.name, description: builtin.description, parameters: builtin.parameters },
  };
}

function imageParts(attachments: JsonObject[]): ChatContentPart[] {
  const parts: ChatContentPart[] = [];
  for (const attachment of attachments) {
    const url = String(attachment.url || attachment.dataUrl || '');
    const mime = String(attachment.mime || attachment.mimeType || '');
    // 只接受可直接引用的图片数据或远程地址，工具输出的真实素材帧才进视觉上下文。
    if (!/^data:image\//i.test(url) && !/^https?:\/\//i.test(url)) continue;
    if (mime && !mime.startsWith('image/')) continue;
    parts.push({ type: 'image_url', image_url: { url } });
  }
  return parts;
}

/**
 * 一次调用的身份：与 LoopGuard 用同一套参数归一化，标点、空格与数值微小抖动
 * 不会被当成"新的尝试"。参数解析不了时按原始文本比较，不做二次猜测。
 */
function callSignature(call: AgentToolCall): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(call.function.arguments || '{}');
  } catch {
    parsed = String(call.function.arguments || '');
  }
  return toolCallFingerprint(call.function.name, parsed);
}

type DispatchSegment = { kind: 'builtin' | 'pipeline'; calls: AgentToolCall[] };

/**
 * 按派发路由把这一轮的调用切成相邻同路由的段。
 *
 * 切成段只为一件事：工具管道可以在整段都是并行安全的只读调用时并发，而循环机制
 * （子 Agent 派发、skill）会自己写历史、状态和事件，必须留在本轮里逐个串行处理。
 * 分段保持模型给出的顺序，段与段之间依旧逐个派发，所以并排放缓不会重排执行语义。
 */
function segmentByDispatchRoute(calls: AgentToolCall[], isBuiltin: (name: string) => boolean): DispatchSegment[] {
  const segments: DispatchSegment[] = [];
  for (const call of calls) {
    const kind = isBuiltin(call.function.name) ? 'builtin' : 'pipeline';
    const last = segments[segments.length - 1];
    if (last && last.kind === kind) last.calls.push(call);
    else segments.push({ kind, calls: [call] });
  }
  return segments;
}

export async function runAgentLoop(input: AgentLoopInput): Promise<AgentLoopResult> {
  const agent = input.agent || agentDefinition(input.context.agentId);
  const messages = input.messages;
  // 一次运行只有一个事件出口：先打上本轮 Agent 的身份，再交给上层。
  // 循环机制事件用这个出口，工具管道事件用 context.emit，两者必须是同一个，
  // 否则子 Agent 的工具回执在 agentRuntimeEvents 里会和父级混成同一个身份。
  const emit = (event: JsonObject & { type: string }) => input.emit({
    agentId: agent.id,
    agentSessionId: input.context.agentSessionId,
    ...event,
  });
  const context: AgentToolContext = { ...input.context, emit };
  const builtinByName = new Map<string, LoopBuiltin>();
  const builtins = createLoopBuiltins({
    agent,
    context,
    emit,
    runSubagent: async (child, task, childSessionId) => {
      // 子 Agent 用自身定义解析可见集：父级的画布写权限不随派发继承。
      // run 事实按引用继承——父子改的是同一个项目，画布写围栏、真实改动标记和回执必须只看一份。
      // state 与已加载 Skill 换新的一份：子 Agent 的终态结论只结束它自己，不能替父级交付结论，
      // 它的重复调用拦截与"最后一条错误"也不该被父级当成自己这一轮的记录。
      const result = await runAgentLoop({
        ...input,
        agent: child,
        context: {
          ...context,
          agentId: child.id,
          agentSessionId: childSessionId,
          turnId: `${childSessionId}:root`,
          state: new Map<string, unknown>(),
          loadedSkillIds: new Set<string>(),
        },
        systemPrompt: buildSubagentPrompt(child.id, child.instructions || ''),
        messages: [{ role: 'user', content: task }],
        onMessagesChanged: undefined,
        // 补充指令属于父级这一轮：子 Agent 不能把它取走，否则父级下一步就收不到用户的话。
        takeSteeringMessages: undefined,
      });
      return result.reply;
    },
  });
  for (const builtin of builtins) builtinByName.set(builtin.name, builtin);

  let modelRounds = 0;
  let reply = '';
  const inputBudget = Math.max(1, input.plan.contextLimit - input.plan.outputLimit);
  // 前缀 = system 提示词 + 本轮工具 schema，每一步都会重新发送。它不参与历史裁剪，
  // 却真实占用输入预算；不扣掉它，窗口"装得下"只是估算上的假象。
  let observedPrefixTokens = 0;
  // 没有步数预算：合法的长任务不该被固定轮次砍断，跑飞由"有没有进展"判定。
  const seenCallSignatures = new Set<string>();
  let stalledRounds = 0;
  let outcomeRequested = false;

  const commit = () => input.onMessagesChanged?.([...messages]);

  /** 循环机制的调用保持串行：子 Agent 派发和 skill 会自己改历史、状态与事件。 */
  const runBuiltinSegment = async (calls: AgentToolCall[]): Promise<Record<string, unknown>[]> => {
    const results: Record<string, unknown>[] = [];
    for (const call of calls) {
      const builtin = builtinByName.get(call.function.name);
      if (!builtin) {
        results.push({ success: false, error: `Unknown loop tool: ${call.function.name}` });
        continue;
      }
      let parsed: JsonObject;
      try {
        parsed = JSON.parse(call.function.arguments || '{}') as JsonObject;
      } catch {
        parsed = {};
      }
      // 子 Agent 的画布写发生在这次派发内部，中断时同样可能已经改过项目。
      markToolCallStarted(context, call.id);
      results.push(await builtin.run(parsed));
    }
    return results;
  };

  /**
   * 取空运行中的用户补充并立刻写进历史，返回这一轮到底收到了几条。
   * 只在真正要用它们的时刻取用：取早了会在模型看不见的位置上消失。
   */
  const takeSteeringIntoHistory = () => {
    const steering = input.takeSteeringMessages?.() || [];
    if (!steering.length) return false;
    for (const text of steering) messages.push({ role: 'user', content: buildSteeringMessage(text) });
    commit();
    return true;
  };

  for (;;) {
    modelRounds += 1;
    const step = modelRounds;
    takeSteeringIntoHistory();
    const turnId = `${input.context.requestId}:step:${step}`;
    const tools = [...serializeLoopTools(context), ...builtins.map(builtinToRequestTool)];
    const estimatedPrefixTokens = estimateTextTokens(input.systemPrompt) + estimateTextTokens(JSON.stringify(tools));
    // 模型上报过真实占用后就以它为准：估算只覆盖文本，上报值还包含供应商自己的开销。
    const prefixTokens = Math.max(estimatedPrefixTokens, observedPrefixTokens);
    const transcriptBudget = Math.max(1, inputBudget - prefixTokens);
    const window = fitTranscript(messages, transcriptBudget);
    if (window.droppedGroups) {
      // 落盘的历史必须与模型真正看到的一致：把内存里的历史收敛到窗口，
      // 否则长会话的 runtimeTranscript 只增不减，最终把整个项目 JSON 撑大。
      messages.length = 0;
      messages.push(...window.messages);
      commit();
      emit({
        type: 'context_compaction', status: 'completed', automatic: true,
        droppedGroups: window.droppedGroups, foldedLines: window.foldedLines,
        createdAt: new Date().toISOString(),
      });
    }
    // 回合是审计对的提交边界：审批只能发生在开启区间内。开启后无论这一步如何结束
    // （返回、continue、抛异常）都在 finally 里闭合，绝不让一个回合跨步骤半开。
    openAgentTurn(context, step);
    try {
      emit({ type: 'turn_start', turn: step, createdAt: new Date().toISOString() });
      const body = buildLoopRequestBody(
        input.plan,
        tools,
        [{ role: 'system', content: input.systemPrompt }, ...window.messages],
      );
      const turn = await input.callModel(body, (delta) => emit({ type: 'text_delta', turnId, delta }));
      // usage.input 是含前缀与工具 schema 的真实占用，反推出的前缀留给下一轮预算。
      if (turn.usage?.input) observedPrefixTokens = Math.max(0, turn.usage.input - window.estimatedTokens);
      // 模型上报真实占用时用上报值，否则用本轮请求的估算值，保证面板不会显示 0。
      const used = (turn.usage?.input || window.estimatedTokens + estimatedPrefixTokens) + (turn.usage?.output || 0);
      emit({
        type: 'context_usage',
        estimatedTokens: used,
        inputLimit: input.plan.contextLimit,
        inputBudget,
        prefixTokens,
        transcriptBudget,
        outputReserve: input.plan.outputLimit,
        ratio: used / inputBudget,
        createdAt: new Date().toISOString(),
      });

      messages.push({
        role: 'assistant',
        content: turn.text || null,
        ...(turn.responseItems?.length ? { responseItems: turn.responseItems } : {}),
        ...(turn.toolCalls.length ? { tool_calls: turn.toolCalls } : {}),
      });
      commit();

      if (turn.finishReason === 'length') {
        throw new Error('Agent 达到本轮输出上限，回复或工具参数可能不完整');
      }

      if (!turn.toolCalls.length) {
        // 模型说完这句话的这一刻用户又补了指令：不能把补充丢掉，也不能让它成为本轮最后的话，
        // 写进历史再继续一轮。补充排在结论回合之前，因为用户的新话可能改变该提交什么结论。
        if (takeSteeringIntoHistory()) continue;
        // 真实改过项目却没有提交通过核验的终态：不替它编造结论，也不静默把一句总结当成交付，
        // 只再给一次结论机会。机会只有一次，避免它反复用文本绕开 report_outcome。
        // 改动标记来自共享的 run，所以子 Agent 落地的写同样要求父级自己收尾；
        // 而终态结论属于本会话，子 Agent 提交过的结论不能替父级交付。
        if (!outcomeRequested
          && context.run.hasAppliedActions
          && !context.state.get('verifiedOutcome')
          && tools.some((tool) => tool.function.name === 'report_outcome')) {
          outcomeRequested = true;
          messages.push({
            role: 'user',
            content: buildConcludeTurnInstruction(String(context.state.get('lastOutcomeIssue') || '')),
          });
          commit();
          continue;
        }
        reply = turn.text;
        if (!reply.trim()) {
          throw new Error('模型返回了 0 token 空响应；请检查文本模型 endpoint 与 OpenAI-compatible 流式响应格式');
        }
        return { reply, modelRounds, messages };
      }

      let progressed = false;
      for (const segment of segmentByDispatchRoute(turn.toolCalls, (name) => builtinByName.has(name))) {
        const results = segment.kind === 'builtin'
          ? await runBuiltinSegment(segment.calls)
          : await executeAgentToolCalls(
            { context, model: input.plan.model },
            segment.calls.map((call) => ({
              callId: call.id, name: call.function.name, argumentsJson: call.function.arguments || '{}',
            })),
          );
        for (const [index, call] of segment.calls.entries()) {
          const signature = callSignature(call);
          // 这一轮试过的新调用，或真实落到项目上的改动，都算向前推进了一步。
          if (!seenCallSignatures.has(signature)) {
            seenCallSignatures.add(signature);
            progressed = true;
          }
          const { __toolAttachments: rawAttachments, ...output } = results[index] || {};
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: await serializeToolOutputForTranscript({
              context, callId: call.id, toolName: call.function.name, text: JSON.stringify(output),
            }),
          });
          const attachments = Array.isArray(rawAttachments) ? rawAttachments as JsonObject[] : [];
          if (attachments.length) {
            const parts = imageParts(attachments);
            if (parts.length) {
              messages.push({
                role: 'user',
                content: [{ type: 'text', text: `以上是工具 ${call.function.name} 返回的真实素材帧，请实际查看后再继续。` }, ...parts],
              });
            }
          }
          const receipt = context.run.toolReceipts.get(call.id);
          if (receipt && receiptChangesProject(receipt)) progressed = true;
          commit();
        }
      }
      if (progressed) {
        stalledRounds = 0;
        continue;
      }
      stalledRounds += 1;
      if (stalledRounds >= STALLED_ROUND_LIMIT) {
        throw new Error(
          `Agent 连续 ${stalledRounds} 轮只重复已经试过的调用，也没有真实改动项目，本轮已停止以避免无限执行`,
        );
      }
    } finally {
      closeAgentTurn(context);
    }
  }
}
