/**
 * 项目级事件溯源投影引擎（ProjectionDefinition 契约 + registry + journal/checkpoint）。
 *
 * 这是对参考实现 `session-projection` 的裁剪落地：真相是只追加的整值事件日志，派生状态是对它的纯折叠。
 * 与 Harness 的差异来自 Shotloom 的既有分层——对外变更通知仍然只有 domainReactivity 一条：
 * 投影折叠只在 view 引用真的变化（`Object.is`）时才把结果物化回项目字段，物化写入再由
 * domainReactivity 合并成一次 revision 通知。渲染路径照旧读 `project.goal` / `project.planMode`，
 * 因此不会引入第二条通知通道，也不会因为折叠而触发无限重渲染。
 *
 * 承重规则：
 * - `apply` 必须同步、纯；对本单元无关的事件**必须返回同一引用**，引用不变即零下游开销。
 * - 事件是整值事件：携带变更后的完整状态，不是增量。
 * - 单元状态必须是普通 JSON（checkpoint 的前提）。
 * - `stateVersion` 变更即作废旧的 checkpoint 行。
 * - 注册是 fail-closed 的：没注册的 key 在快照里不存在，读它就是能力缺失。
 */
import { toRaw } from './domainReactivity.ts';

export type ProjectionData = Record<string, unknown>;

/** 一条已提交的整值事件。`seq` 在 host 内单调递增，checkpoint 后继续递增不重置。 */
export interface ProjectionEvent {
  seq: number;
  type: string;
  data: ProjectionData;
}

/**
 * 投影宿主的作用域。项目宿主的状态会随项目 JSON 持久化（进 checkpoint 行）；
 * 会话宿主只活在内存里（一次 Agent 运行的生命周期），绝不写进项目快照。
 */
export type ProjectionScope = 'project' | 'session';

/**
 * 一个领域的状态驱动计算单元：纯折叠 + 声明 + 可选读面。
 * `validate` 是 Harness `stateSchema` 的等价物，用来在 checkpoint 行播种前校验持久状态。
 */
export interface ProjectionDefinition<S, V> {
  /** 本单元拥有的投影 key。 */
  key: string;
  /**
   * 本单元属于哪类宿主。缺省为 `project`（可持久化）；
   * 只有显式声明 `session` 的运行态投影才不进 checkpoint 行。
   */
  scope?: ProjectionScope;
  /** 序列化状态字段或折叠语义变更时递增，用来作废旧 checkpoint 行。 */
  stateVersion: number;
  /** 空日志下的初始状态。 */
  init(): S;
  /** 纯转移：无关事件必须返回 `state` 本身。 */
  apply(state: S, event: ProjectionEvent): S;
  /** 校验持久化状态；非法返回 null（该行被丢弃）。 */
  validate?: ((state: unknown) => S | null) | undefined;
  /** 状态 → 对外值（读面）。 */
  view(state: S): V;
}

/** 把变化的 view 写回宿主（项目字段）。只有 view 引用变化时才调用。 */
export type ProjectionMaterializer<V> = (target: unknown, view: V) => void;

/** 投影宿主：项目宿主持久化日志，会话宿主只活在内存里。 */
export interface ProjectionHost {
  readonly scope: 'project' | 'session';
  /**
   * 物化目标：调用方传入的原始对象（可能是 domainReactivity 的 Proxy）。
   * 物化必须经过它，写入才会触发 domainReactivity 的合并通知。
   */
  readonly target: unknown;
  /**
   * 存储记录：`toRaw` 后的对象，用来读写 journal / checkpoint / seq 本身。
   * 读 raw 保证折叠运算作用在普通 JSON 上，不被 Proxy 包装干扰引用判定。
   */
  readonly storage: Record<string, unknown> | null;
  readonly journal: ProjectionEvent[];
  readonly cells: Map<string, ProjectionCell>;
  nextSeq: number;
}

interface ProjectionCell {
  state: unknown;
  observedSeq: number;
}

interface Registration {
  key: string;
  scope: ProjectionScope;
  stateVersion: number;
  init: () => unknown;
  apply: (state: unknown, event: ProjectionEvent) => unknown;
  validate?: ((state: unknown) => unknown | null) | undefined;
  view: (state: unknown) => unknown;
  materialize?: ((target: unknown, view: unknown) => void) | undefined;
}

const registrations = new Map<string, Registration>();
const projectCells = new WeakMap<object, Map<string, ProjectionCell>>();

/** 项目尾日志上限：超过即压实成 checkpoint，保证存储有界。 */
const MAX_PROJECT_TAIL = 256;
/** 会话尾日志上限：会话没有 checkpoint，压实即保留既有 cell 并清空日志。 */
const MAX_SESSION_TAIL = 512;

/**
 * 注册一个投影单元。同 key 同 `stateVersion` 的重复注册是无操作（模块热重载与多入口都靠它幂等）；
 * 同 key 不同版本直接报错，避免两个语义不同的折叠共享一个 key。
 */
export function registerProjection<S, V>(
  definition: ProjectionDefinition<S, V>,
  materialize?: ProjectionMaterializer<V>,
): () => void {
  const existing = registrations.get(definition.key);
  if (existing !== undefined) {
    if (existing.stateVersion !== definition.stateVersion) {
      throw new Error(
        `projection key ${JSON.stringify(definition.key)} 已按 stateVersion ${existing.stateVersion} 注册，`
        + `拒绝与 stateVersion ${definition.stateVersion} 共用同一个 key`,
      );
    }
    return () => undefined;
  }
  if (!Number.isSafeInteger(definition.stateVersion) || definition.stateVersion < 0) {
    throw new Error(`projection key ${JSON.stringify(definition.key)} 的 stateVersion 必须是非负整数`);
  }
  registrations.set(definition.key, {
    key: definition.key,
    scope: definition.scope ?? 'project',
    stateVersion: definition.stateVersion,
    init: () => definition.init(),
    apply: (state, event) => definition.apply(state as S, event),
    view: (state) => definition.view(state as S),
    ...(definition.validate ? { validate: (state: unknown) => definition.validate?.(state) ?? null } : {}),
    ...(materialize ? { materialize: (target: unknown, view: unknown) => materialize(target, view as V) } : {}),
  });
  return () => {
    registrations.delete(definition.key);
  };
}

/** 已注册的投影 key（测试与诊断用）。 */
export function registeredProjectionKeys(): string[] {
  return [...registrations.keys()];
}

function rawTarget(project: unknown): object | null {
  const raw = toRaw(project as object) as object | undefined;
  return raw && typeof raw === 'object' ? raw : null;
}

/** 项目宿主：日志与 seq 持久化在 `project.projectionJournal` / `project.projectionSeq`，cell 按项目缓存。 */
export function projectProjectionHost(project: unknown): ProjectionHost {
  const raw = rawTarget(project);
  if (!raw) throw new Error('projection host 需要一个项目对象');
  const record = raw as Record<string, unknown>;
  if (!Array.isArray(record.projectionJournal)) record.projectionJournal = [];
  if (!Number.isSafeInteger(record.projectionSeq) || Number(record.projectionSeq) < 0) {
    record.projectionSeq = 0;
  }
  let cells = projectCells.get(raw);
  if (cells === undefined) {
    cells = new Map();
    projectCells.set(raw, cells);
  }
  return {
    scope: 'project',
    target: project,
    storage: record,
    journal: record.projectionJournal as ProjectionEvent[],
    cells,
    nextSeq: Number(record.projectionSeq),
  };
}

/** 会话宿主：纯内存，随一次 Agent 运行建立与销毁。 */
export function createSessionProjectionHost(target: unknown = null): ProjectionHost {
  return { scope: 'session', target, storage: null, journal: [], cells: new Map(), nextSeq: 0 };
}

function checkpointRow(host: ProjectionHost, registration: Registration): ProjectionCell | null {
  if (host.scope !== 'project' || host.storage === null) return null;
  const rows = host.storage.projectionCheckpoint;
  if (!rows || typeof rows !== 'object') return null;
  const row = (rows as Record<string, unknown>)[registration.key];
  if (!row || typeof row !== 'object') return null;
  const entry = row as Record<string, unknown>;
  if (entry.ver !== registration.stateVersion) return null;
  const value = registration.validate ? registration.validate(entry.state) : entry.state;
  if (value === null || value === undefined) return null;
  return {
    state: value,
    observedSeq: Number.isSafeInteger(entry.seq) ? Number(entry.seq) : -1,
  };
}

/** 折叠一个单元：checkpoint 行可用就从行播种，否则从 init 开始，再前向重放尾日志。 */
function buildCell(host: ProjectionHost, registration: Registration): ProjectionCell {
  const seeded = checkpointRow(host, registration);
  let state = seeded ? seeded.state : registration.init();
  let observedSeq = seeded ? seeded.observedSeq : -1;
  for (const event of host.journal) {
    if (event.seq <= observedSeq) continue;
    state = registration.apply(state, event);
    observedSeq = event.seq;
  }
  return { state, observedSeq };
}

function ensureCell(host: ProjectionHost, registration: Registration): ProjectionCell {
  const existing = host.cells.get(registration.key);
  if (existing) return existing;
  const cell = buildCell(host, registration);
  host.cells.set(registration.key, cell);
  return cell;
}

function materializeAll(host: ProjectionHost): void {
  for (const registration of registrations.values()) {
    if (!registration.materialize) continue;
    const cell = ensureCell(host, registration);
    registration.materialize(host.target, registration.view(cell.state));
  }
}

/**
 * 提交一条整值事件：先物化既有尾日志（把 cell 推到事件之前），再前向折叠这一条，
 * 最后只对引用真的变化过的单元调用物化。返回已提交事件。
 */
export function commitProjectionEvent(
  host: ProjectionHost,
  type: string,
  data: ProjectionData,
): ProjectionEvent {
  for (const registration of registrations.values()) ensureCell(host, registration);
  const event: ProjectionEvent = { seq: host.nextSeq, type, data };
  host.nextSeq += 1;
  host.journal.push(event);
  for (const registration of registrations.values()) {
    const cell = ensureCell(host, registration);
    const next = registration.apply(cell.state, event);
    cell.observedSeq = event.seq;
    if (Object.is(next, cell.state)) continue;
    cell.state = next;
    registration.materialize?.(host.target, registration.view(next));
  }
  if (host.scope === 'project') {
    if (host.storage) host.storage.projectionSeq = host.nextSeq;
    if (host.journal.length > MAX_PROJECT_TAIL) checkpointProjectHost(host);
  } else if (host.journal.length > MAX_SESSION_TAIL) {
    for (const registration of registrations.values()) ensureCell(host, registration);
    host.journal.length = 0;
  }
  return event;
}

/** 读一个单元的状态（缺失即未注册 / 未物化时返回 undefined）。 */
export function stateOfProjection<S>(host: ProjectionHost, key: string): S | undefined {
  const registration = registrations.get(key);
  if (!registration) return undefined;
  return ensureCell(host, registration).state as S;
}

/** 读一个单元的对外值。 */
export function projectionView<V>(host: ProjectionHost, key: string): V | undefined {
  const registration = registrations.get(key);
  if (!registration) return undefined;
  return registration.view(ensureCell(host, registration).state) as V;
}

function collectCheckpointRows(host: ProjectionHost): Record<string, unknown> {
  const rows: Record<string, unknown> = {};
  for (const registration of registrations.values()) {
    // 会话作用域的运行态投影不进项目快照：它们随一次 Agent 运行失效，写进 checkpoint 只会污染项目 JSON。
    if (registration.scope !== host.scope) continue;
    const cell = ensureCell(host, registration);
    rows[registration.key] = {
      ver: registration.stateVersion,
      seq: cell.observedSeq,
      state: clonePlain(cell.state),
    };
  }
  return rows;
}

function checkpointProjectHost(host: ProjectionHost): void {
  if (host.storage === null) return;
  host.storage.projectionCheckpoint = collectCheckpointRows(host);
  host.journal.length = 0;
}

/** 保存前压实：把尾日志折叠进 checkpoint 行并清空尾。无尾日志时是空操作。 */
export function checkpointProjectProjections(project: unknown): void {
  const raw = rawTarget(project);
  if (!raw) return;
  const host = projectProjectionHost(raw);
  if (!host.journal.length) return;
  checkpointProjectHost(host);
}

/**
 * 加载时重放：只有存在日志或 checkpoint 证据时才以日志为准重建并物化字段；
 * 二者都空（legacy 项目）时不动物化字段，交给 normalizeProjectState 的就地规范化。
 */
export function restoreProjectProjections(project: unknown): void {
  const raw = rawTarget(project);
  if (!raw) return;
  const record = raw as Record<string, unknown>;
  const checkpoint = record.projectionCheckpoint;
  const hasCheckpoint = !!checkpoint && typeof checkpoint === 'object'
    && Object.keys(checkpoint as object).length > 0;
  const hasJournal = Array.isArray(record.projectionJournal) && (record.projectionJournal as unknown[]).length > 0;
  if (!hasCheckpoint && !hasJournal) return;
  const host = projectProjectionHost(raw);
  host.cells.clear();
  materializeAll(host);
}

/**
 * 会话运行态投影：当前是否有开启的模型回合。审批必须发生在开启的回合内（审计对是回合提交边界的
 * 一部分），因此审批前置检查读的就是它。它是 `session` 作用域：只活在内存里，随一次运行失效，
 * 绝不写进项目 JSON。
 */
export const TURN_BOUNDARY_KEY = 'turnBoundary';

export interface TurnBoundaryState {
  /** 当前是否处在一次已开启、尚未闭合的模型回合内。 */
  open: boolean;
  /** 最近一次开启的回合序号（从 1 开始）；没有回合时为 0。 */
  turn: number;
}

registerProjection<TurnBoundaryState, TurnBoundaryState>({
  key: TURN_BOUNDARY_KEY,
  scope: 'session',
  stateVersion: 1,
  init: () => ({ open: false, turn: 0 }),
  apply: (state, event) => {
    if (event.type === 'turn/start') {
      const turn = Number(event.data.turn) || 0;
      return state.open && state.turn === turn ? state : { open: true, turn };
    }
    if (event.type === 'turn/end') return state.open ? { open: false, turn: state.turn } : state;
    return state;
  },
  validate: (value) => {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    return { open: record.open === true, turn: Number(record.turn) || 0 };
  },
  view: (state) => state,
});

function clonePlain<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value)) as T;
}
