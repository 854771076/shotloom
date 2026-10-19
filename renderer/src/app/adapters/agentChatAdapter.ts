import { EDITOR_AGENT_ID, TEXT_AGENT_ID } from "../../agent/agents/definitions";
import {
  resolveClarification,
  resolveToolConfirmation,
} from "../agent-session/agentInteractionCoordinator";
import { listAgentInteractions } from "../../agent/runtime/runStore";
import { getModelInfo } from "../../domain/catalog/ModelCatalog";
import { resolveProviderIconId } from "../../domain/provider/ProviderBrandIcons.ts";
import {
  canvasAgentConversation,
  clearAgentConversation,
  clearGoal,
  completeGoal,
  createAgentConversation,
  createGoal,
  deleteAgentConversation,
  editGoal,
  editorAgentConversation,
  isPlanMode,
  pauseGoal,
  readGoal,
  resumeGoal,
  scopedAgentConversations,
  setPlanMode,
  switchAgentConversation,
  textAgentConversation,
  type AgentGoal,
} from "../../services/agentConversations.ts";
import { store, touchProject } from "../../store/projectStore";
import {
  getAvailableAgentModelCatalog,
  saveAppSettings,
  settingsStore,
} from "../../store/settingsStore";
import type { AgentController, AgentGoalView, AgentMessage } from "../agent-chat/contracts";
import { showToast } from "../../store/notificationStore";
import { focusCanvasNodes } from "./canvasAdapter";
import { toRaw } from "../../store/domainReactivity.ts";
import { recordPerformanceMetric } from "../../services/performanceMetrics";
import {
  compactInactiveAgentSessions,
  dropAgentSessionArchive,
  restoreAgentSession,
} from "../../services/agentSessionLifecycle.ts";
import { agentSession } from "./agentSession";

type Loose = Record<string, any>;

/**
 * 文本模型下拉的缓存。
 *
 * 目录解析要遍历全部厂商配置，而面板每次渲染都要读它；只在配置对象真的换掉时重算。
 */
let textModelConfigSource: object | null = null;
let cachedTextModels: Array<{ id: string; label: string; iconId: string }> = [];
function availableTextModels() {
  const source = toRaw(settingsStore.providerConfigs) as object;
  if (source === textModelConfigSource) return cachedTextModels;
  textModelConfigSource = source;
  const catalog = getAvailableAgentModelCatalog();
  cachedTextModels = (
    catalog.find((item: Loose) => item.type === "textGeneration")?.models || []
  ).map((model: Loose) => ({
    id: model.id,
    label: model.name || getModelInfo(model.id)?.name || model.id,
    iconId: resolveProviderIconId(model.provider, model.id, model.iconId),
  }));
  return cachedTextModels;
}

export function maintainAgentSessionMemory() {
  const startedAt = performance.now();
  const result = compactInactiveAgentSessions(toRaw(store.project));
  if (result.compacted) {
    recordPerformanceMetric("agent.sessions.compact", startedAt, result);
    agentSession.notify();
  }
  return result;
}

/** 文本面板的"新建会话"落在该文本节点的作用域，不跟随项目级 active 指针。 */
export function newTextConversation(nodeId: string): void {
  if (agentSession.isBusy()) return;
  createAgentConversation(store.project, {
    title: "文本 Agent", agentId: TEXT_AGENT_ID, textNodeId: String(nodeId || ""),
  });
  touchProject();
  agentSession.notify();
}

export function agentPanelData(scope: 'canvas' | 'editor' | 'text' = 'canvas', scopedNodeId = '') {
  const scoped = scopedAgentConversations(store.project, scope, scopedNodeId) as Loose[];
  const conversation = scope === 'editor'
    ? editorAgentConversation(store.project, scopedNodeId)
    : scope === 'text'
    ? textAgentConversation(store.project, scopedNodeId)
    : canvasAgentConversation(store.project);
  const interactionList = listAgentInteractions();
  const interactions = new Map(interactionList.map((item) => [item.id, item]));
  for (const message of conversation.messages as Loose[]) {
    for (const tool of message.toolCalls || []) {
      const interaction = interactions.get(String(tool.interactionId || ""));
      if (interaction && interaction.status !== "pending") {
        tool.pending = false;
        tool.status = interaction.status === "expired" ? "error" : tool.status;
      }
    }
    for (const clarification of message.clarifications || []) {
      const interaction = interactions.get(String(clarification.interactionId || ""));
      if (interaction && interaction.status !== "pending") {
        clarification.answered = true;
        clarification.expired = interaction.status === "expired";
      }
    }
  }
  const textModels = availableTextModels();
  const configured = settingsStore.agentPreferredTextModel;
  return {
    messages: conversation.messages as AgentMessage[],
    // 目标与计划模式是项目级持久事实，面板只读这一份；改写永远走 runCommand 的 CAS 动词。
    goal: readGoal(store.project as Loose) as AgentGoalView | null,
    planMode: isPlanMode(store.project as Loose),
    goalArmed: agentSession.isGoalDriverArmed(),
    conversations: scoped.map((item: Loose) => {
      const pending = interactionList.filter(
        (interaction) =>
          interaction.conversationId === String(item.id) && interaction.status === "pending",
      );
      return {
        id: item.id,
        editorNodeId: item.editorNodeId,
        title: item.title,
        updatedAt: item.updatedAt,
        pendingInteractionCount: pending.length,
        waitingKind: pending.some((interaction) => interaction.kind === "question")
          ? "question"
          : pending.length
            ? "tool_confirmation"
            : "",
      };
    }),
    // 列表与高亮必须来自同一作用域解析结果，否则抽屉会把另一个作用域的会话 id 当作选中项。
    activeConversationId: String(conversation.id || ""),
    busy: agentSession.isBusy(),
    textModel: textModels.some((item: Loose) => item.id === configured)
      ? configured
      : textModels[0]?.id || "",
    textModels,
  };
}

// 目标状态回显：命令只据实呈现持久状态，不评判目标该不该继续——那仍是模型与工具的判断。
// 暂停/恢复/完成/清除已经由目标条上的按钮承载，这里不再重复教一遍操作。
function goalStatusText(goal: AgentGoal | null): string {
  if (!goal) return '当前没有长期目标。用 /goal <目标描述> 设定一个，Agent 会把它带入后续每一轮。';
  const label: Record<string, string> = { active: '进行中', paused: '已暂停', blocked: '受阻', complete: '已完成' };
  const lines = [
    `当前长期目标（${label[goal.phase] || goal.phase}）：${goal.objective}`,
    `自动续行轮次：${goal.roundsStarted}/${goal.maxGoalRounds}`,
  ];
  if (goal.phase === 'blocked' && goal.blockedReason) lines.push(`受阻原因：${goal.blockedReason}`);
  return lines.join('\n');
}

// goal/plan 是项目级持久状态：命令改完后按与其它会话写入一致的节奏落盘并通知界面。
function commitGoalPlanChange() {
  touchProject({ sessionDelay: 250, coalesceSession: true });
  agentSession.notify();
}

export const agentPanelController: AgentController = {
  openVideoEditorConversation: (nodeId: string) => {
    if (agentSession.isBusy()) return;
    const existing = (store.project.agentConversations || []).find(
      (item: Loose) => item.editorNodeId === nodeId,
    );
    if (existing) {
      restoreAgentSession(toRaw(store.project), String(existing.id));
      switchAgentConversation(store.project, String(existing.id));
    } else {
      createAgentConversation(store.project, {
        title: "剪辑 Agent", agentId: EDITOR_AGENT_ID, editorNodeId: nodeId,
      });
    }
    touchProject();
    agentSession.notify();
  },
  send: (payload) => {
    // 共享 controller 的 send 只服务画布面板；剪辑面板会覆盖 send 并自带剪辑会话。
    // 缺省目标固定为画布作用域的活动会话，不跟随项目级 active 指针，否则画布消息会被写进剪辑会话。
    return agentSession.deliver({
      ...payload,
      conversationId: payload.conversationId
        || String(canvasAgentConversation(store.project).id || ""),
    });
  },
  // /goal 创建或恢复目标后启动目标续行；/plan <正文> 由界面作为本轮请求发送。
  // 状态变更成功不再回显文本：目标条与计划徽标才是这份状态的可见处，失败才回错误。
  runCommand: (command, ctx) => {
    const project = store.project as Loose;
    const conversationId = String(ctx.conversationId || '');
    const push = (text: string) => agentSession.pushLocalMessage(text, conversationId);
    if (command.kind === 'goal') {
      const goal = readGoal(project);
      switch (command.action) {
        case 'status':
          push(goalStatusText(goal));
          return {};
        case 'set': {
          const objective = String(command.objective || '').trim();
          if (!objective) return { error: '用法：/goal <目标描述>' };
          const result = goal && goal.phase !== 'complete'
            ? editGoal(project, { id: goal.id, revision: goal.revision }, { objective })
            : createGoal(project, objective);
          if (!result.ok) return { error: result.error };
          commitGoalPlanChange();
          agentSession.startGoal(ctx.model, conversationId);
          return {};
        }
        case 'clear':
          if (!goal) return { error: '当前没有长期目标。' };
          clearGoal(project);
          commitGoalPlanChange();
          return {};
        case 'pause':
        case 'resume':
        case 'complete': {
          if (!goal) return { error: '当前没有长期目标。' };
          const ref = { id: goal.id, revision: goal.revision };
          const result = command.action === 'pause'
            ? pauseGoal(project, ref)
            : command.action === 'resume'
              ? resumeGoal(project, ref)
              : completeGoal(project, ref);
          if (!result.ok) return { error: result.error };
          commitGoalPlanChange();
          if (command.action === 'resume') agentSession.startGoal(ctx.model, conversationId);
          return {};
        }
        default:
          return {};
      }
    }
    if (command.action === 'exit') {
      if (!isPlanMode(project)) return { error: '当前不在计划模式。' };
      setPlanMode(project, false);
      commitGoalPlanChange();
      return {};
    }
    if (command.action === 'status') {
      push(isPlanMode(project)
        ? '当前处于计划模式：Agent 只做只读调研与规划。用 /plan exit 退出。'
        : '当前不在计划模式。用 /plan <本轮请求> 进入。');
      return {};
    }
    setPlanMode(project, true);
    commitGoalPlanChange();
    // 有正文时界面会把正文发出去；没有正文时给一行说明，告诉用户下一步该输入什么。
    if (command.deliverText) return { deliverText: command.deliverText };
    push('已进入计划模式：描述本轮任务，Agent 会先只做只读调研并产出计划，待你确认后再执行。');
    return {};
  },
  // 目标条的续播按钮：目标仍是进行中但驱动已停用（用户停止或上一轮失败）时重新武装第一轮。
  goalDrive: ({ conversationId, model }) => agentSession.startGoal(model, String(conversationId || '')),
  // goal 命令只改本地状态，运行中也能执行；plan 命令会发送本轮请求，必须等当前运行结束。
  isCommandRunBusy: (command) => {
    if (!agentSession.isBusy()) return false;
    return command.kind === 'plan';
  },
  close: () => {},
  cancel: () => agentSession.cancelActiveRun(),
  retry: (messageId) => {
    if (agentSession.isBusy()) return;
    // 重试必须回到失败消息所属的会话：项目级 active 可能停在另一个作用域。
    const conversation = ((store.project.agentConversations || []) as Loose[]).find((item) =>
      (item.messages || []).some((message: Loose) => message.id === messageId),
    );
    const message = (conversation?.messages || []).find((item: Loose) => item.id === messageId);
    if (!message?.retryable || !message.retryPayload) {
      showToast("这条失败消息没有可用的重试信息");
      return;
    }
    message.retryable = false;
    touchProject();
    agentSession.notify();
    agentSession.deliver(
      {
        text: String(message.retryPayload.text || ""),
        model: String(message.retryPayload.model || ""),
        attachments: [...(message.retryPayload.attachments || [])],
        nodeMentions: [...(message.retryPayload.nodeMentions || [])],
        conversationId: String(conversation?.id || ""),
      },
      undefined,
      { skipUserMessage: true },
    );
  },
  clear: (conversationId?: string) => {
    const target = String(conversationId || "")
      || String(canvasAgentConversation(store.project).id || "");
    if (
      listAgentInteractions({ pendingOnly: true }).some(
        (item) => item.conversationId === target,
      )
    ) {
      showToast("当前对话仍有问题或操作等待处理，完成后才能清空");
      return;
    }
    clearAgentConversation(store.project, target);
    touchProject();
    agentSession.notify();
    showToast("当前 Agent 对话上下文已清空");
  },
  newConversation: (editorNodeId?: string) => {
    if (agentSession.isBusy()) return;
    const nodeId = String(editorNodeId || "");
    createAgentConversation(
      store.project,
      nodeId
        ? { title: "剪辑 Agent", agentId: EDITOR_AGENT_ID, editorNodeId: nodeId }
        : {},
    );
    touchProject();
    agentSession.notify();
    showToast(nodeId ? "已新建剪辑对话" : "已新建项目对话");
  },
  selectConversation: (id) => {
    if (!agentSession.isBusy()) restoreAgentSession(toRaw(store.project), id);
    if (!agentSession.isBusy() && switchAgentConversation(store.project, id)) {
      touchProject();
      agentSession.notify();
      maintainAgentSessionMemory();
    }
  },
  deleteConversation: (id) => {
    if (listAgentInteractions({ pendingOnly: true }).some((item) => item.conversationId === id)) {
      showToast("这个会话仍有问题或操作等待处理，完成后才能删除");
      return;
    }
    if (!agentSession.isBusy() && deleteAgentConversation(store.project, id)) {
      dropAgentSessionArchive(String(store.project.id || ''), id);
      touchProject();
      agentSession.notify();
      showToast("会话已删除");
    }
  },
  changeModel: (model) => {
    void saveAppSettings({ agentPreferredTextModel: model }).then(agentSession.notify);
  },
  submitClarification: (payload: unknown) => {
    const value = payload as Loose;
    try {
      const resolution = resolveClarification(
        String(value?.interactionId || ""),
        Array.isArray(value?.answers) ? value.answers : [],
        value?.skipped === true,
        !agentSession.isBusy(),
      );
      if (resolution.resume) agentSession.deliver(resolution.resume.payload, resolution.resume, { skipUserMessage: true, priority: true });
      agentSession.notify();
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : String(cause));
    }
  },
  approveToolCall: (payload: unknown) => {
    const value = payload as Loose;
    const interactionId = String(value.interactionId || "");
    if (!interactionId) return;
    const modifiedArgs = value.modifiedArgs && typeof value.modifiedArgs === "object"
      ? (value.modifiedArgs as Record<string, unknown>)
      : undefined;
    void resolveToolConfirmation(interactionId, true, !agentSession.isBusy(), modifiedArgs)
      .then((resolution) => {
        if (resolution.resume) agentSession.deliver(resolution.resume.payload, resolution.resume, { skipUserMessage: true, priority: true });
        agentSession.notify();
      })
      .catch((cause) => showToast(cause instanceof Error ? cause.message : String(cause)));
  },
  rejectToolCall: (payload: unknown) => {
    const value = payload as Loose;
    const interactionId = String(value.interactionId || "");
    if (!interactionId) return;
    void resolveToolConfirmation(interactionId, false, !agentSession.isBusy())
      .then((resolution) => {
        if (resolution.resume) agentSession.deliver(resolution.resume.payload, resolution.resume, { skipUserMessage: true, priority: true });
        agentSession.notify();
      })
      .catch((cause) => showToast(cause instanceof Error ? cause.message : String(cause)));
  },
  focusNodes: (nodeIds) => {
    const existing = new Set((store.project.nodes || []).map((node: Loose) => String(node.id)));
    const ids = nodeIds.filter((id) => existing.has(id));
    if (!ids.length) return showToast("这个阶段还没有可定位的画布产物");
    focusCanvasNodes(ids);
    showToast(`已选中 ${ids.length} 个阶段产物`);
  },
};
