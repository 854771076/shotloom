// 会话归属的 Agent id。权威定义在 renderer/src/agent/agents/definitions.ts，
// 这里只保留作用域到 id 的映射，本模块不反向依赖 Agent 运行时。
import {
  commitProjectionEvent,
  projectProjectionHost,
  registerProjection,
  type ProjectionDefinition,
} from '../store/projectProjections.ts';

const SCOPE_AGENT_IDS = { canvas: 'canvas-primary', editor: 'editor-primary', text: 'text-primary' } as const;

export type ConversationScope = 'canvas' | 'editor' | 'text';

/**
 * 长期目标的持久 phase。四种都是可持久状态；进程本地的"是否自动续行"不属于这里。
 * blocked 是唯一携带稳定原因文本的 phase，用来说明为何停在这里。
 */
export type GoalPhase = 'active' | 'paused' | 'blocked' | 'complete';

/**
 * 项目级持久目标。`{id, revision}` 是比较并设置（CAS）的身份：每次变更 revision 递增，
 * 携带旧 revision 的更新会被拒绝，持有陈旧视图的一方得到清晰错误而不是静默覆盖。
 */
export interface AgentGoal {
  id: string;
  revision: number;
  objective: string;
  phase: GoalPhase;
  maxGoalRounds: number;
  roundsStarted: number;
  blockedReason?: string;
  createdAt: string;
  updatedAt: string;
}

const GOAL_PHASES: readonly GoalPhase[] = ['active', 'paused', 'blocked', 'complete'];
const DEFAULT_MAX_GOAL_ROUNDS = 256;

// 消息结构由对话运行时写入，本模块只按数组搬运、去重和清空，不解释字段。
export interface ConversationMessage {
  id?: string | undefined;
  role?: string | undefined;
  content?: unknown;
  createdAt?: string | number | undefined;
  [key: string]: unknown;
}

export interface AgentConversation {
  id?: string | undefined;
  title?: string | undefined;
  agentId?: string | undefined;
  editorNodeId?: string | undefined;
  textNodeId?: string | undefined;
  messages?: ConversationMessage[];
  agentMessages?: unknown;
  runtimeTranscript?: unknown;
  contextUsage?: unknown;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
  archivedMessageCount?: number | undefined;
  mode?: unknown;
  [key: string]: unknown;
}

export interface ConversationProject {
  id?: string | undefined;
  agentConversations?: AgentConversation[] | undefined;
  activeAgentConversationId?: string | undefined;
  agentSteps?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

/**
 * goal/plan 是项目级持久状态，不是会话级：一个项目同时只有一个进行中的目标与一个计划模式开关。
 * 动词只接收这个最小形状，避免反向依赖 store；调用方把 `store.project`（any）直接传入即可。
 */
export interface ProjectState {
  goal?: AgentGoal | null;
  planMode?: boolean;
  updatedAt?: string | undefined;
  [key: string]: unknown;
}

export interface CreateConversationOptions {
  title?: string | undefined;
  agentId?: string | undefined;
  editorNodeId?: string | undefined;
  textNodeId?: string | undefined;
}

function uid(): string {
  return globalThis.crypto?.randomUUID?.() || `conversation-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** 已经是规范形状的 goal：字段齐全且类型正确，规范化时保持原引用不变。 */
function goalIsCanonical(goal: unknown): goal is AgentGoal {
  if (!goal || typeof goal !== 'object') return false;
  const item = goal as Record<string, unknown>;
  return typeof item.id === 'string' && !!item.id
    && Number.isInteger(item.revision) && Number(item.revision) >= 1
    && typeof item.objective === 'string' && !!String(item.objective).trim()
    && GOAL_PHASES.includes(item.phase as GoalPhase)
    && Number.isFinite(Number(item.maxGoalRounds)) && Number(item.maxGoalRounds) >= 1
    && Number.isFinite(Number(item.roundsStarted)) && Number(item.roundsStarted) >= 0;
}

/** 把一个磁盘/历史里的 goal 值规范成可运行形状；空白 objective 视为没有目标。 */
function normalizeGoal(value: unknown): AgentGoal | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const objective = String(item.objective ?? '').replace(/\s+/g, ' ').trim();
  if (!objective) return null;
  const now = new Date().toISOString();
  const maxGoalRounds = Number(item.maxGoalRounds);
  const roundsStarted = Number(item.roundsStarted);
  const goal: AgentGoal = {
    id: typeof item.id === 'string' && item.id ? item.id : uid(),
    revision: Number.isInteger(item.revision) && Number(item.revision) >= 1 ? Number(item.revision) : 1,
    objective,
    phase: GOAL_PHASES.includes(item.phase as GoalPhase) ? item.phase as GoalPhase : 'active',
    maxGoalRounds: Number.isFinite(maxGoalRounds) && maxGoalRounds >= 1 ? Math.floor(maxGoalRounds) : DEFAULT_MAX_GOAL_ROUNDS,
    roundsStarted: Number.isFinite(roundsStarted) && roundsStarted >= 0 ? Math.floor(roundsStarted) : 0,
    createdAt: typeof item.createdAt === 'string' ? item.createdAt : now,
    updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : now,
  };
  const blockedReason = typeof item.blockedReason === 'string' ? item.blockedReason.trim() : '';
  if (blockedReason) goal.blockedReason = blockedReason;
  return goal;
}

/**
 * 读取当前规范 goal；非法/legacy 值就地规范化。规范化只在真正需要时写回——
 * 已是规范对象时返回同一引用，绝不新建对象。goal 是项目级持久状态，只经 normalizeProjectState
 * 在保存/加载路径规范化；渲染路径不得调用它，否则改写对象引用会每次 bump domain revision 触发无限重渲染。
 */
function readCanonicalGoal(project: ProjectState): AgentGoal | null {
  if (goalIsCanonical(project.goal)) return project.goal;
  const normalized = project.goal === undefined ? null : normalizeGoal(project.goal);
  if (project.goal !== normalized) project.goal = normalized;
  return normalized;
}

// ── 项目级事件溯源投影：goal 与 planMode ────────────────────────────────
// 真相是只追加的整值事件日志；`project.goal` / `project.planMode` 是派生缓存，只由折叠物化。
// 事件携带变更后的完整状态（整值事件规则），因此每次 apply 都极便宜、每个值自描述。
// 注册是 fail-closed 的：没注册的 key 读不到，读它就是能力缺失。

const GOAL_PROJECTION_STATE_VERSION = 1;

interface GoalProjectionState {
  current: AgentGoal | null;
  /** 出现过的目标 id；清除目标后仍保留，用于重放时不与历史目标混淆。 */
  seenGoalIds: string[];
  /** 严格重放失败时置位；宿主读到它就抛错，而不是静默返回脏值。 */
  failure: string | null;
}

function validateGoalProjectionState(value: unknown): GoalProjectionState | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const current = record.current === null || record.current === undefined
    ? null
    : (goalIsCanonical(record.current) ? record.current : normalizeGoal(record.current));
  const seen = Array.isArray(record.seenGoalIds)
    ? record.seenGoalIds.filter((id): id is string => typeof id === 'string' && !!id)
    : [];
  if (current && !seen.includes(current.id)) seen.push(current.id);
  const failure = typeof record.failure === 'string' && record.failure ? record.failure : null;
  return { current, seenGoalIds: [...new Set(seen)], failure };
}

const goalProjectionDefinition: ProjectionDefinition<GoalProjectionState, AgentGoal | null> = {
  key: 'goal',
  stateVersion: GOAL_PROJECTION_STATE_VERSION,
  init: () => ({ current: null, seenGoalIds: [], failure: null }),
  apply: (state, event) => {
    if (state.failure !== null || event.type !== 'goal/change') return state;
    const next = (event.data as { goal?: unknown }).goal;
    const current = next === null || next === undefined
      ? null
      : (goalIsCanonical(next) ? next : normalizeGoal(next));
    if (next !== null && next !== undefined && current === null) {
      return { ...state, failure: 'goal 事件携带了无法规范化的目标快照' };
    }
    const seenGoalIds = [...state.seenGoalIds];
    if (current && !seenGoalIds.includes(current.id)) seenGoalIds.push(current.id);
    return { current, seenGoalIds, failure: null };
  },
  validate: validateGoalProjectionState,
  view: (state) => state.current,
};

const PLAN_MODE_PROJECTION_STATE_VERSION = 1;

interface PlanModeProjectionState { active: boolean }

const planModeProjectionDefinition: ProjectionDefinition<PlanModeProjectionState, boolean> = {
  key: 'planMode',
  stateVersion: PLAN_MODE_PROJECTION_STATE_VERSION,
  init: () => ({ active: false }),
  apply: (state, event) => {
    if (event.type !== 'plan/change') return state;
    const active = (event.data as { active?: unknown }).active === true;
    return active === state.active ? state : { active };
  },
  validate: (value) => {
    if (!value || typeof value !== 'object') return null;
    return { active: (value as { active?: unknown }).active === true };
  },
  view: (state) => state.active,
};

// 物化只写派生字段；写回经调用方传入的原始对象（可能是 domainReactivity 的 Proxy），
// 因此变更会并入 domainReactivity 的一次 revision 通知，渲染路径不需要第二套订阅。
registerProjection(goalProjectionDefinition, (target, view) => {
  (target as ProjectState).goal = view;
});
registerProjection(planModeProjectionDefinition, (target, view) => {
  (target as ProjectState).planMode = view;
});

/** 提交一条 goal 整值事件；折叠结果会物化回 `project.goal`。 */
function commitGoalEvent(project: ProjectState, goal: AgentGoal | null): void {
  commitProjectionEvent(projectProjectionHost(project), 'goal/change', { goal });
}

/** 提交一条 planMode 整值事件；折叠结果会物化回 `project.planMode`。 */
function commitPlanModeEvent(project: ProjectState, active: boolean): void {
  commitProjectionEvent(projectProjectionHost(project), 'plan/change', { active });
}


export function ensureAgentConversations(project: ConversationProject | null | undefined): AgentConversation[] {
  if (!project || typeof project !== 'object') return [];
  const original = Array.isArray(project.agentConversations) ? project.agentConversations : [];
  let conversations = original.filter((item) => item && typeof item === 'object');
  if (!conversations.length) {
    const now = new Date().toISOString();
    conversations = [{
      id: uid(),
      title: '新对话',
      messages: [],
      contextUsage: null,
      createdAt: now,
      updatedAt: now,
    }];
    project.agentConversations = conversations;
  } else if (conversations.length !== original.length) {
    project.agentConversations = conversations;
  }
  for (const conversation of conversations) {
    if (!conversation.id) conversation.id = uid();
    else if (typeof conversation.id !== 'string') conversation.id = String(conversation.id);
    // agentId 决定这个会话能使用哪个 Agent 的工具与 Skill 集合，必须显式存在于记录上。
    if (!conversation.agentId) {
      conversation.agentId = conversation.textNodeId
        ? SCOPE_AGENT_IDS.text
        : conversation.editorNodeId ? SCOPE_AGENT_IDS.editor : SCOPE_AGENT_IDS.canvas;
    }
    const title = String(conversation.title || '新对话').slice(0, 80);
    if (conversation.title !== title) conversation.title = title;
    delete conversation.mode;
    // transient 消息属于当前 WebView 的运行中状态。这里只规范结构，不能在每次
    // getActiveAgentConversation() 时删除，否则流式回复框会在首个 delta 前消失。
    // 落盘快照会在 projectStore.projectPersistenceSnapshot() 中单独过滤 transient。
    if (!Array.isArray(conversation.messages)) conversation.messages = [];
    delete conversation.agentMessages;
  }
  const first = conversations[0];
  if (first && !conversations.some((item) => item.id === project.activeAgentConversationId)) {
    project.activeAgentConversationId = first.id;
  }
  // 调用方（create/switch/delete/clear）必须改动 project 上的规范数组本身，
  // 而不是 ensure 过滤后的副本，否则新会话不会出现在项目数据里。
  return Array.isArray(project.agentConversations) ? project.agentConversations : conversations;
}

export function getActiveAgentConversation(project: ConversationProject): AgentConversation | null {
  const conversations = ensureAgentConversations(project);
  return conversations.find((item) => item.id === project.activeAgentConversationId) || conversations[0] || null;
}

// 画布、每个剪辑工作区和每个文本编辑器各自拥有独立会话，互不可见。project.activeAgentConversationId
// 只是项目级的“最近所在会话”指针，不能用来判断某个面板该显示哪个会话，否则剪辑会话会
// 抢走画布面板的消息归属。作用域解析必须由这里统一决定。
export function scopedAgentConversations(
  project: ConversationProject,
  scope: ConversationScope = 'canvas',
  boundNodeId = '',
): AgentConversation[] {
  const conversations = ensureAgentConversations(project);
  const nodeId = String(boundNodeId || '');
  if (scope === 'editor') {
    if (!nodeId) return [];
    return conversations.filter((item) => String(item.editorNodeId || '') === nodeId);
  }
  if (scope === 'text') {
    if (!nodeId) return [];
    return conversations.filter((item) => String(item.textNodeId || '') === nodeId);
  }
  // 工作区会话（剪辑、文本）不属于画布列表，否则会在画布历史抽屉里互相污染。
  return conversations
    .filter((item) => !item.editorNodeId && !item.textNodeId)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

// 画布作用域的活动会话。画布面板必须始终落在画布会话上：即使项目级指针指向剪辑会话，
// 也不能让画布面板读写剪辑会话。
export function canvasAgentConversation(project: ConversationProject): AgentConversation {
  const conversations = scopedAgentConversations(project, 'canvas');
  const active = conversations.find((item) => item.id === project.activeAgentConversationId);
  if (active) return active;
  const first = conversations[0];
  if (first) return first;
  return createAgentConversation(project);
}

// 剪辑作用域的活动会话。一个剪辑工作区同时只保留一个会话，首次读取即建立，
// 使面板读取与发送指向同一个会话。
export function editorAgentConversation(project: ConversationProject, editorNodeId: string): AgentConversation {
  const nodeId = String(editorNodeId || '');
  const conversations = scopedAgentConversations(project, 'editor', nodeId);
  const first = conversations[0];
  if (!nodeId) return first || getActiveAgentConversation(project) || createAgentConversation(project);
  if (first) return first;
  return createAgentConversation(project, {
    title: '剪辑 Agent', agentId: SCOPE_AGENT_IDS.editor, editorNodeId: nodeId,
  });
}

// 文本编辑器作用域。一个文本节点同时只保留一个会话，首次读取即建立，
// 使面板读取与发送指向同一个会话。
export function textAgentConversation(project: ConversationProject, textNodeId: string): AgentConversation {
  const nodeId = String(textNodeId || '');
  const conversations = scopedAgentConversations(project, 'text', nodeId);
  const first = conversations[0];
  if (!nodeId) return first || getActiveAgentConversation(project) || createAgentConversation(project);
  if (first) return first;
  return createAgentConversation(project, {
    title: '文本 Agent', agentId: SCOPE_AGENT_IDS.text, textNodeId: nodeId,
  });
}

export function createAgentConversation(project: ConversationProject, options: CreateConversationOptions = {}): AgentConversation {
  const canonical = ensureAgentConversations(project);
  const now = new Date().toISOString();
  const conversation: AgentConversation = {
    id: uid(),
    title: String(options.title || '新对话').slice(0, 80),
    agentId: String(options.agentId || SCOPE_AGENT_IDS.canvas),
    // 工作区会话在建立时就绑定所属节点，避免先落成画布会话再改作用域。
    ...(options.editorNodeId ? { editorNodeId: String(options.editorNodeId) } : {}),
    ...(options.textNodeId ? { textNodeId: String(options.textNodeId) } : {}),
    messages: [],
    contextUsage: null,
    createdAt: now,
    updatedAt: now,
  };
  canonical.unshift(conversation);
  project.activeAgentConversationId = conversation.id;
  return conversation;
}

export function switchAgentConversation(project: ConversationProject, conversationId: string): AgentConversation | null {
  const conversations = ensureAgentConversations(project);
  if (!conversations.some((item) => item.id === conversationId)) return null;
  project.activeAgentConversationId = conversationId;
  return getActiveAgentConversation(project);
}

export function deleteAgentConversation(project: ConversationProject, conversationId: string): AgentConversation | null {
  const conversations = ensureAgentConversations(project);
  const id = String(conversationId || '');
  const index = conversations.findIndex((item) => item.id === id);
  if (index < 0) return null;

  const deletingActive = project.activeAgentConversationId === id;
  conversations.splice(index, 1);
  if (Array.isArray(project.agentSteps)) {
    project.agentSteps = project.agentSteps.filter((step) => String(step?.conversationId || '') !== id);
  }

  if (!conversations.length) {
    project.activeAgentConversationId = '';
    return getActiveAgentConversation(project);
  }
  if (deletingActive) {
    const nextIndex = Math.min(index, conversations.length - 1);
    project.activeAgentConversationId = conversations[nextIndex]?.id || '';
  }
  return getActiveAgentConversation(project);
}

// 清空必须按目标会话执行：画布面板与剪辑面板的“清空当前会话”各自只影响自己的作用域。
// 目标 id 缺失或失效时退回项目级活动会话，避免清错另一个作用域的会话。
export function clearAgentConversation(project: ConversationProject, conversationId: string): AgentConversation | null {
  const conversations = ensureAgentConversations(project);
  const requested = String(conversationId || '');
  const conversation = conversations.find((item) => item.id === requested)
    || getActiveAgentConversation(project);
  if (!conversation) return conversation;
  conversation.messages = [];
  delete conversation.agentMessages;
  // runtimeTranscript 是自研 Agent loop 写给模型的可见历史；界面清空时它必须一起消失，
  // 否则对话框空了而模型仍记得上一轮。ensure 不会删除它，只有清空才删。
  delete conversation.runtimeTranscript;
  conversation.contextUsage = null;
  conversation.updatedAt = new Date().toISOString();
  return conversation;
}

export function titleConversationFromMessage(conversation: AgentConversation | null | undefined, message: unknown): void {
  if (!conversation || conversation.title !== '新对话') return;
  const title = String(message || '').replace(/\s+/g, ' ').trim();
  if (title) conversation.title = title.slice(0, 28);
}

// ── 长期目标：比较并设置（CAS）状态机 ──────────────────────────────────
// 用户 `/goal` 命令与模型工具都只通过这一组动词改目标，保证只有一条持久路径。
// goal/plan 是项目级状态；每次成功变更 revision 递增，携带旧 revision 的调用被拒绝，
// 而不是覆盖更新的视图。

/**
 * 项目级 goal/plan 的唯一规范化入口，只在 createProject 与 normalizeProject（保存/加载路径）调用，
 * 渲染与 ensure 路径不得调用。两者都幂等：planMode 布尔同值不写，goal 已是规范对象时保持引用，
 * 只有磁盘/legacy 的真需要规范化的值才就地写回，绝不每次新建对象。
 */
export function normalizeProjectState(project: ProjectState | null | undefined): void {
  if (!project || typeof project !== 'object') return;
  const planMode = project.planMode === true;
  if (project.planMode !== planMode) project.planMode = planMode;
  readCanonicalGoal(project);
}

export interface GoalRef {
  id: string;
  revision: number;
}

export type GoalResult = { ok: true; goal: AgentGoal } | { ok: false; error: string };

/**
 * 变更目标时允许显式写入的字段。每个都带 `| undefined`：
 * exactOptionalPropertyTypes 下，清除可选字段（如完成时清 blockedReason）要用 undefined 表达，
 * nextRevision 会把 undefined 键删除。
 */
type GoalPatch = {
  objective?: string | undefined;
  maxGoalRounds?: number | undefined;
  phase?: GoalPhase | undefined;
  roundsStarted?: number | undefined;
  blockedReason?: string | undefined;
};

/** 读取当前项目的规范目标；没有则 null。只在保存/加载与命令/工具路径调用，幂等、不改引用。 */
export function readGoal(project: ProjectState): AgentGoal | null {
  return readCanonicalGoal(project);
}

function writeGoal(project: ProjectState, goal: AgentGoal): AgentGoal {
  commitGoalEvent(project, goal);
  project.updatedAt = new Date().toISOString();
  return goal;
}

function nextRevision(goal: AgentGoal, patch: GoalPatch): AgentGoal {
  const next: AgentGoal = {
    ...goal,
    objective: patch.objective !== undefined ? patch.objective : goal.objective,
    maxGoalRounds: patch.maxGoalRounds !== undefined ? patch.maxGoalRounds : goal.maxGoalRounds,
    roundsStarted: patch.roundsStarted !== undefined ? patch.roundsStarted : goal.roundsStarted,
    phase: patch.phase !== undefined ? patch.phase : goal.phase,
    revision: goal.revision + 1,
    updatedAt: new Date().toISOString(),
  };
  // 显式携带 blockedReason 键才改动它：undefined 表示清除（完成/恢复），字符串表示写入（阻塞）。
  if ('blockedReason' in patch) {
    if (patch.blockedReason === undefined) delete next.blockedReason;
    else next.blockedReason = patch.blockedReason;
  }
  return next;
}

function matchCas(project: ProjectState, ref: GoalRef): { goal: AgentGoal } | { error: string } {
  const goal = readCanonicalGoal(project);
  if (!goal) return { error: '当前会话没有目标，无法执行该操作' };
  if (goal.id !== String(ref.id) || goal.revision !== Number(ref.revision)) {
    return { error: `目标已被更新（当前 id=${goal.id}，revision=${goal.revision}）。请重新读取目标后再修改。` };
  }
  return { goal };
}

export function createGoal(
  project: ProjectState,
  objective: string,
  maxGoalRounds?: number,
): GoalResult {
  const clean = String(objective || '').replace(/\s+/g, ' ').trim();
  if (!clean) return { ok: false, error: '目标描述不能为空' };
  const existing = readCanonicalGoal(project);
  // 一个项目同时只有一个目标：未完成的必须先完成/暂停/清除，不能被静默替换。
  if (existing && existing.phase !== 'complete') {
    return { ok: false, error: `已有进行中的目标：${existing.objective}。请先完成、暂停或清除它，再设定新目标。` };
  }
  const bounded = Number(maxGoalRounds);
  const now = new Date().toISOString();
  return { ok: true, goal: writeGoal(project, {
    id: uid(),
    revision: 1,
    objective: clean,
    phase: 'active',
    maxGoalRounds: Number.isFinite(bounded) && bounded >= 1 ? Math.floor(bounded) : DEFAULT_MAX_GOAL_ROUNDS,
    roundsStarted: 0,
    createdAt: now,
    updatedAt: now,
  }) };
}

export function editGoal(
  project: ProjectState,
  ref: GoalRef,
  patch: { objective?: string | undefined; maxGoalRounds?: number | undefined },
): GoalResult {
  const matched = matchCas(project, ref);
  if ('error' in matched) return { ok: false, error: matched.error };
  const goal = matched.goal;
  const next: GoalPatch = {};
  if (patch.objective !== undefined) {
    const clean = String(patch.objective).replace(/\s+/g, ' ').trim();
    if (!clean) return { ok: false, error: '目标描述不能为空' };
    next.objective = clean;
  }
  if (patch.maxGoalRounds !== undefined) {
    const bounded = Number(patch.maxGoalRounds);
    if (!Number.isFinite(bounded) || bounded < 1) return { ok: false, error: '目标轮次上限必须是正整数' };
    next.maxGoalRounds = Math.floor(bounded);
  }
  if (!Object.keys(next).length) return { ok: false, error: '没有要修改的目标内容' };
  return { ok: true, goal: writeGoal(project, nextRevision(goal, next)) };
}

function transition(
  project: ProjectState,
  ref: GoalRef,
  to: GoalPhase,
  validate?: (goal: AgentGoal) => string | null,
  extra?: GoalPatch,
): GoalResult {
  const matched = matchCas(project, ref);
  if ('error' in matched) return { ok: false, error: matched.error };
  const goal = matched.goal;
  const problem = validate ? validate(goal) : null;
  if (problem) return { ok: false, error: problem };
  return { ok: true, goal: writeGoal(project, nextRevision(goal, { phase: to, ...extra })) };
}

export function pauseGoal(project: ProjectState, ref: GoalRef): GoalResult {
  return transition(project, ref, 'paused',
    (goal) => (goal.phase === 'active' ? null : `只有进行中的目标可以暂停（当前为 ${goal.phase}）`));
}

export function resumeGoal(project: ProjectState, ref: GoalRef): GoalResult {
  return transition(project, ref, 'active',
    (goal) => {
      if (goal.phase === 'active') return '目标已在进行中';
      if (goal.phase === 'complete') return '目标已完成，无法恢复；请设定新目标';
      if (goal.roundsStarted >= goal.maxGoalRounds) return '目标轮次已达上限，无法恢复';
      return null;
    },
    { blockedReason: undefined });
}

export function completeGoal(project: ProjectState, ref: GoalRef): GoalResult {
  return transition(project, ref, 'complete',
    (goal) => (goal.phase === 'complete' ? '目标已完成' : null),
    { blockedReason: undefined });
}

export function blockGoal(project: ProjectState, ref: GoalRef, reason: string): GoalResult {
  const clean = String(reason || '').trim();
  if (!clean) return { ok: false, error: '阻塞原因不能为空' };
  return transition(project, ref, 'blocked',
    (goal) => (goal.phase === 'complete' ? '目标已完成，不能再标记为阻塞' : null),
    { blockedReason: clean });
}

/** 清除当前目标；无目标时为幂等空操作，返回 ok 以便调用方给出确定回执。 */
export function clearGoal(project: ProjectState): { ok: true } {
  if (project.goal !== null) commitGoalEvent(project, null);
  project.updatedAt = new Date().toISOString();
  return { ok: true };
}

export type GoalRoundResult =
  | { continued: true; goal: AgentGoal }
  | {
      continued: false;
      reason: 'no-goal' | 'inactive' | 'round-limit';
      goal: AgentGoal | null;
    };

/**
 * 自动续行 driver 的每轮入口：只有 phase=active 且未达轮次上限时，才把 roundsStarted 加一
 * （随之 revision 递增、updatedAt 刷新）并回执可继续；其余情况只据实返回原因、不改状态。
 * 进程本地的"是否武装/停用"不属于这里——由会话层决定何时调用，本函数只负责那份持久轮次进度。
 */
export function takeGoalRound(project: ProjectState): GoalRoundResult {
  const goal = readCanonicalGoal(project);
  if (!goal) return { continued: false, reason: 'no-goal', goal: null };
  if (goal.phase !== 'active') return { continued: false, reason: 'inactive', goal };
  if (goal.roundsStarted >= goal.maxGoalRounds) {
    return { continued: false, reason: 'round-limit', goal };
  }
  return {
    continued: true,
    goal: writeGoal(project, nextRevision(goal, { roundsStarted: goal.roundsStarted + 1 })),
  };
}

// ── 计划模式：一个项目级布尔开关 ──────────────────────────────────────
// 激活只改变提示词引导，不裁剪任何工具；强制限制仍由权限层负责。

export function isPlanMode(project: ProjectState): boolean {
  return project.planMode === true;
}

export function setPlanMode(project: ProjectState, active: boolean): boolean {
  const next = active === true;
  if (project.planMode !== next) commitPlanModeEvent(project, next);
  project.updatedAt = new Date().toISOString();
  return next;
}
