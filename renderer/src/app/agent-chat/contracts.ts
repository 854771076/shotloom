import type { AgentArtifactRefs } from "./artifactHelpers";
import type { AgentReference } from "./mediaReference";
import type { SlashCommand } from "./slashCommands";
import type { WorkflowNodeData } from "../canvas/WorkflowCanvas";

/**
 * 项目级长期目标的界面视图。字段与 services/agentConversations 的规范对象一致，
 * 界面只读不写，也不在这里维护第二套目标结构。
 */
export interface AgentGoalView {
  id: string;
  revision: number;
  objective: string;
  phase: "active" | "paused" | "blocked" | "complete";
  maxGoalRounds: number;
  roundsStarted: number;
  blockedReason?: string;
}

/** 可被 @ 引用的画布节点，以及它在输入区呈现出的媒体预览。 */
export interface MentionableNode {
  id: string;
  alias: string;
  title: string;
  typeLabel: string;
  imageAttachment: Record<string, unknown> | null;
  node: WorkflowNodeData;
}

/**
 * Agent 面板与运行时之间的呈现契约。面板只消费这里声明的数据，
 * 不感知底层 runtime 是哪一个，也不从消息文本反推执行状态。
 */
export interface AgentMessage {
  id: string;
  role: string;
  title?: string;
  content?: string;
  typing?: boolean;
  error?: string;
  retryable?: boolean;
  deliveryStage?: "sent" | "started" | "completed" | "failed" | "cancelled";
  deliveryError?: string;
  diagnosis?: {
    code?: string;
    title?: string;
    message?: string;
    primaryAction?: string;
    suggestions?: string[];
  };
  meta?: string[];
  /**
   * 应用自己写入的一行提示，不是模型正文：`divider` 是轮次边界，`status` 是需要看见但
   * 不该伪装成助手回复的事实（轮次上限、持久化失败）。界面按行呈现，不叠加轨迹/计划/产物。
   */
  notice?: "divider" | "status";
  /** 用户这条消息引用的真实素材，界面按媒体卡呈现。 */
  references?: AgentReference[];
  toolCalls?: AgentToolCall[];
  /** 本轮派发过的子 Agent，用于显示"谁在执行、子任务到哪一步、结论是什么"。 */
  subagents?: AgentSubagentView[];
  productionPlan?: AgentPlanView;
  artifactRefs?: AgentArtifactRefs;
  clarifications?: Array<{
    interactionId?: string;
    runId?: string;
    questions?: Array<{
      id?: string;
      header?: string;
      question?: string;
      options?: string[];
      multiple?: boolean;
      required?: boolean;
    }>;
    answered?: boolean;
    expired?: boolean;
  }>;
}

export interface AgentToolCall {
  id?: string;
  name?: string;
  /** 展示主文案。真实工具由界面从工具注册表解析，技能/模板这类非注册表行由事件层直接给出。 */
  title?: string;
  kind?: "skill" | "recipe" | "tool" | "system";
  effect?: string;
  status?: string;
  summary?: string;
  /** 工具真实产出的文字描述；没有产出时为空，界面不得用入参冒充结果。 */
  output?: string;
  /** tool_start 携带的完整调用参数；展开步骤时如实展示，缺失时不显示参数区。 */
  args?: Record<string, unknown>;
  /** 真实派发与结算的时间戳，用于在摘要行尾部给出耗时。 */
  startedAt?: string;
  endedAt?: string;
  /** 工具产出的本地位图（如抽帧结果），用于让用户核对 Agent 的依据。 */
  previews?: Array<{ path: string; label: string }>;
  pending?: boolean;
  runId?: string;
  stepId?: string;
  interactionId?: string;
  /** 待确认调用的原始参数；存在时用户可以在确认前修改。 */
  pendingArgs?: Record<string, unknown>;
  /** 执行这一步的 Agent 与会话；界面按会话把子 Agent 的步骤归到它的任务下面。 */
  agentId?: string;
  agentSessionId?: string;
  /** 事件到达顺序，用于把子任务标题插在父级步骤之间而不是堆到末尾。 */
  seq?: number;
}

/**
 * 一次子 Agent 派发的呈现视图。`agentId` 可能为空（事件未上报或身份未知），
 * 界面此时只能显示通用文案，不能冒充某个具体 Agent。
 */
export interface AgentSubagentView {
  /** 派发时生成的子会话 id，与工具行的 agentSessionId 对应。 */
  id?: string;
  agentId?: string;
  title?: string;
  /** 父 Agent 交给它的完整任务说明。 */
  task?: string;
  status?: string;
  /** 子 Agent 返回给父级的结论；失败时为空，错误在 error 里。 */
  summary?: string;
  error?: string;
  runId?: string;
  seq?: number;
}

export interface AgentPlanStageView {
  id?: string;
  order?: number;
  title?: string;
  description?: string;
  status?: string;
  authored?: boolean;
  workItems?: Array<{ id?: string; title?: string; outputType?: string; prompt?: string }>;
  runtimeRefs?: Array<{ workItemId?: string; nodeId?: string; taskId?: string }>;
  summary?: string;
  blockedReason?: string;
}

export interface AgentPlanView {
  schemaVersion?: number;
  id?: string;
  title?: string;
  goal?: string;
  executionMode?: string;
  revision?: number;
  stages?: AgentPlanStageView[];
}

export interface ConversationItem {
  id: string;
  editorNodeId?: string;
  title?: string;
  updatedAt?: string;
  pendingInteractionCount?: number;
  waitingKind?: string;
}

export interface AgentController {
  openVideoEditorConversation?: (nodeId: string) => void;
  send: (payload: {
    text: string;
    model: string;
    attachments: unknown[];
    nodeMentions: unknown[];
    /** 展示层引用描述，只随消息持久化，不发给模型。 */
    references?: AgentReference[];
    conversationId?: string;
  }) => boolean;
  /** 命令层是否按忙闲拦截：goal 状态变更随时可执行，plan 开关与查询在运行中不生效。 */
  isCommandRunBusy: (command: SlashCommand) => boolean;
  /**
   * 执行一条斜杠命令：改项目级 goal/plan 持久状态。
   * 成功不再回显文本（目标条与计划徽标就是状态的唯一可见处），失败回清晰错误；
   * `/plan <正文>` 会把正文回传给界面，由界面作为本轮真实请求发出。
   */
  runCommand: (
    command: SlashCommand,
    ctx: { conversationId: string; model: string },
  ) => { deliverText?: string; error?: string };
  /** 重新武装当前进行中目标的自动续行：进程本地决策，只属于会话层。 */
  goalDrive: (ctx: { conversationId: string; model: string }) => void;
  clear: (conversationId?: string) => void;
  close: () => void;
  cancel: () => void;
  retry: (messageId: string) => void;
  newConversation: (editorNodeId?: string) => void;
  selectConversation: (id: string) => void;
  deleteConversation: (id: string) => void;
  changeModel: (model: string) => void;
  submitClarification: (payload: unknown) => void;
  approveToolCall: (payload: unknown) => void;
  rejectToolCall: (payload: unknown) => void;
  focusNodes: (nodeIds: string[]) => void;
}

export interface AgentPanelHandle {
  /** 画布「加入对话」入口：按节点 id 追加一条引用。 */
  addNodeMentionById: (nodeId: string) => void;
}

export interface TextModelOption {
  id: string;
  label: string;
  iconId: string;
}

/**
 * 面板一次读取到的全部呈现数据。goal 与 plan 的项目级状态在这里一次性交给界面，
 * 界面不再自己去 store 读第二份，也不维护自己的目标结构。
 */
export interface AgentPanelData {
  messages: AgentMessage[];
  conversations: ConversationItem[];
  activeConversationId: string;
  busy: boolean;
  textModel: string;
  textModels: TextModelOption[];
  goal: AgentGoalView | null;
  planMode: boolean;
  /** 自动续行是否处于武装状态：进程本地运行决策，与持久 phase 共同决定是否可点播放。 */
  goalArmed: boolean;
}
