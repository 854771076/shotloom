# DeepSeek Harness → Shotloom 架构迁移计划

> 参考实现：`/Users/xiaomao26_1_12/projecets/deepseek-harness-master/packages/{session,goal,interaction}`
> 目标工程：Shotloom（Tauri + React，自研 Agent loop，P1–P6 已落地）
> 约束：不破坏现有 612 测试；不引入向后兼容层（预发布阶段）；保持 domainReactivity / zustand 分层；保留 AGENTS.md 的 fail-closed 规则。

---

## 0. 先确认理解：ProjectionDefinition 与 domainReactivity 是两个不同的东西

这是整个迁移的地基，必须先说清楚，否则会把两个引擎混成一个。

### Harness 的 `ProjectionDefinition`（`session-projection`）

- **真相是日志**：一个 Session 是一条只追加的 `SessionEvent` 序列（`session/event`）。所有派生状态都是对这条日志的纯折叠。
- **投影是一个纯同步函数单元**，不是 getter：
  - `init(header, inheritedEventCount) -> S`
  - `apply(state, event) -> S` —— 对本单元无关的事件**必须返回同一个引用**（`Object.is`）；引用不变就零下游开销。
  - `wire.view(state) -> 客户端值`（可选），再加 `stateSchema` / `viewSchema` 校验。
  - `stateVersion`：折叠语义或序列化字段一变更就 +1，用来作废持久化的 checkpoint 行。
- **框架拥有订阅、游标与通知**：`SessionProjectionRegistry` 只订阅一次 `session/event`，把每个已提交事件**急推**过每个已注册单元的 `apply`；每会话每单元的游标/单元格存在 `WeakMap<Session, UnitCell>`；只有当 `view` 的原始结果 `Object.is` 变化时才发变更通知。
- **整值事件规则（承重）**：带状态的事件必须携带**变更后的完整状态**，不是增量。于是每次 `apply` 都极便宜，每个被服务出来的值自描述。
- **纯 JSON 状态**：`state` 必须是普通 JSON（可持久化缓存的前提）。
- **Checkpoint/Restore**：持久化行 `(key, ver, seq, val)`；`restoreFloor` 给冷读的下界（低一格的锚点用来侦测日志被截断），`restore` 用「缓存态 + 前向尾重放 + view」一条读取配方重建。
- **注册即副作用**：注册随调用 fiber 生命周期，key 在卸载后从快照里消失 —— 客户端把它读成「能力缺失」（fail-closed）。

### Shotloom 的 `domainReactivity`（`store/domainReactivity.ts`）

- **真相是可变的项目对象**：`store.project` 是一个就地可变的松散 JSON 图，通过 `Proxy` 拦截 `set`/`deleteProperty`。
- **变更被合并通知**：任意一次写入把 `revision += 1`，并用一个 microtask 合并所有写，向 `subscribeDomain` 的订阅者只发一次通知；界面用 `useSyncExternalStore(subscribeDomain, getDomainRevision)` 消费。
- **没有日志、没有折叠、没有游标、没有 checkpoint、没有 stateVersion、没有 per-key 变更feed**。持久化是**整个项目 JSON 快照**，加载时用 `normalizeProjectState` 就地规范化。
- 现有的 goal 是**命令式 CAS 状态机**：`createGoal/editGoal/pauseGoal/...` 直接改 `project.goal`，`revision` 是 CAS 版本号（不是日志序号），`takeGoalRound` 是唯一推进 `roundsStarted` 的落点。

### 两者关系（这次迁移的桥）

| 维度 | Harness | 当前 Shotloom | 迁移后 Shotloom |
| --- | --- | --- | --- |
| 真相 | 事件日志 | 可变项目对象 | **项目级事件日志（projection journal）为投影切片的真相**，`project.goal`/`project.planMode` 变派生缓存 |
| 变更 | 纯 `apply` 返回新引用 | Proxy 就地写 | 纯 `apply` 折叠 + 只把变化后的 view 物化回项目字段 |
| 变更检测 | `Object.is` on view | Proxy set + microtask 合并 | 两级：`apply` 用 `Object.is` 抑制无谓物化；物化写入再触发 domainReactivity 合并通知 |
| 生命周期 | per-session 单元 + fiber 注册 | 模块单例 store | 注册是模块级（Shotloom 无 fiber）；host 分「项目」与「会话」两类 |
| 持久化 | checkpoint 行 + 尾重放 | 整项目 JSON | checkpoint 行 + 尾重放，落在项目 JSON 内 |
| 变更主体 | 模型/命令共同 append | 命令式 CAS 动词 | CAS 动词 = append 事件 + 折叠 + 物化 |
| `revision` | 日志序号 | 通知计数 / CAS 版本 | **两者都保留且语义分离**：`project.goal.revision` 仍是 CAS，`seq` 是日志序号 |

**关键结论**：迁移不是「用日志替换 domainReactivity」，而是「在 domainReactivity 之下插入一层事件日志，让 goal/planMode/turnBoundary 变成可重放的投影；domainReactivity 仍是唯一的对外变更通知机制」。渲染路径一个字都不改（仍读 `project.goal`），因此不会引入无限重渲染。

---

## 1. 差距清单与映射

| 优先级 | 差距 | Harness 出处 | Shotloom 现状 | 迁移落点 |
| --- | --- | --- | --- | --- |
| 🔴 HIGH | Session Projection System | `packages/session/session-projection/src/index.ts` | 无日志，goal/planMode 命令式直改 | 新增 `store/projectProjections.ts`；改 `services/agentConversations.ts`、`store/projectNormalization.ts` |
| 🔴 HIGH | Goal Reservation & Checkpoint | `packages/goal/goal-round-driver/src/index.ts` | `agentSession.scheduleGoalRound` 无 checkpint、无预约校验、无 competing-queued | 改 `app/adapters/agentSession.ts` |
| 🔴 HIGH | Approval Waterfall | `packages/interaction/user-approval/src/index.ts` | `executeToolCall` 内联确认，无策略、无审计对、无回合约束 | 新增 `agent/runtime/approvalWaterfall.ts`；改 `agent/runtime/executeToolCall.ts`、`store/settingsStore.ts` |
| 🟡 MED | Tool Pipeline Stages | Harness 工具管道 | `executeAgentToolCall` 单函数 | 暂缓（见 §5） |
| 🟡 MED | Handle Persistence | `session-persistence` | 已有 `LatestSaveQueue` + 整项目快照 | 计划落盘已在 `takeGoalRound` 前后做，增强为显式 checkpoint |
| 🟡 MED | Turn Boundaries | `turn/start`/`turn/end` | loop 已有 `turn_start` 事件，无 turn/end、无投影 | 会话投影 host 里新增 `turnBoundary` 投影 |
| 🟢 LOW | Frozen Messages / Inbox Splices / Runtime Context | — | — | **不迁移**（收益不明确，见 §6） |

---

## 2. 迁移总原则

1. **每次改动必须有明确收益**：可重放性、竞态消除、审计合规三者之一，否则不做。
2. **分层不动**：投影引擎住 `store/`（领域与持久状态）；界面仍只消费 zustand 或 domainReactivity。会话投影 host 是运行态，活在 `agentSession` 闭包与 `toolContext.state` 里，不进界面。
3. **`apply` 纯、同步、引用不变即返回原引用**。
4. **fail-closed 优先**：注册缺失 = 能力缺失；无开启回合 = 不写审计对、拒绝审批；预约校验不过 = 不派发。
5. **不引入兼容层**：goal 的读写 API 语义保持（`project.goal` 仍是规范对象），但底层实现直接换成事件 + 折叠，不留旧的「直写」分支。
6. **规范化只在加载/创建路径做一次且幂等**：投影重放放在 `normalizeProject`（加载）与 `createProject`（创建）里，**绝不放渲染路径**；`normalizeProjectState` 的引用稳定性契约不变。

---

## 3. P1 Session Projection System

### 3.1 设计

新增 `renderer/src/store/projectProjections.ts`，提供：

```
ProjectionEvent   = { seq: number; type: string; data: JsonObject }        // 整值事件
ProjectionDefinition<S, V> = {
  key: string
  stateVersion: number
  init(): S
  apply(state: S, event: ProjectionEvent): S      // 纯；无关事件返回原引用
  validate?(state: unknown): S | null             // stateSchema 的等价物
  view(state: S): V
}
ProjectionHost    = { journal: ProjectionEvent[]; cells: Map<string, Cell>; scope: 'project' | 'session' }
```

- `createProjectionHost(scope)`：项目 host 从 `project.projectionJournal` 懒建；会话 host 是纯内存对象。
- `ProjectionRegistry`（模块级、单一）：
  - `register(def, materialize?)` → disposer；重复注册同 key 必须 `stateVersion` 一致，否则报错（Harness 同款）。
  - `stateOf(host, key)` / `snapshot(host)`：物化所有单元到当前游标（缺 cell 就折叠日志）。
  - `commit(host, type, data)`：追加整值事件、逐单元 `apply`、只对 `Object.is` 变化过的单元调用 `materialize(project, view)`。
  - `restore(project)`：从 checkpoint 行 + 尾日志重建（加载路径）。
  - `checkpoint(project)`：把每个单元状态写成 `{ver, seq, val}` 并清空尾日志（保存路径）。
- 项目 host 的 journal 存在 `project.projectionJournal`，checkpoint 存在 `project.projectionCheckpoint`；会话 host 不持久化。

三个投影定义：

| key | 事件 | state | view | 物化到 |
| --- | --- | --- | --- | --- |
| `goal` | `goal/change` | `{current: AgentGoal\|null, seenGoalIds: string[], failure: string\|null}` | `state.current` | `project.goal` |
| `planMode` | `plan/change` | `{active: boolean}` | `state.active` | `project.planMode` |
| `turnBoundary` | `turn/start` / `turn/end` | `{open: boolean, turn: number}` | `{open, turn}` | 无（host-only，会话 host） |

`goal/change` 是整值事件，携带完整 goal 快照；`clear` 事件携带 tombstone（id + revision+1）并把 `current` 置 null，`seenGoalIds` 保留（Harness 同款，用于防重放歧义）。

### 3.2 文件清单

| 操作 | 文件 | 说明 |
| --- | --- | --- |
| 新增 | `renderer/src/store/projectProjections.ts` | 契约 + registry + 三个投影定义 + journal/checkpoint |
| 修改 | `renderer/src/services/agentConversations.ts` | goal/planMode 动词改为 `commit(...)`；`readGoal`/`isPlanMode` 读投影；`normalizeProjectState` 保持 |
| 修改 | `renderer/src/store/projectNormalization.ts` | `createProject` 初始化 journal/checkpoint；`normalizeProject` 调 `restoreProjectProjections` |
| 修改 | `renderer/src/store/projectStore.ts` | 持久化快照前 `checkpointProjectProjections` |
| 修改 | `renderer/src/agent/loop/agentLoop.ts` | 会话 host：`turn/start` / `turn/end` 写入 host |
| 新增 | `tests/agent-project-projections.test.mjs` | 纯函数、幂等、引用稳定、重放、checkpoint、turn 边界 |

### 3.3 迁移路径（不破坏现有契约）

1. 落地 registry 与三个定义；goal/planMode 动词改成「append + 折叠 + 物化」，对 `project.goal`/`project.planMode` 的对外形状与 CAS 语义**逐字不变**（现有 `agent-conversations.test.mjs` / `agent-goal-rounds.test.mjs` 直接读 `project.goal.*`）。
2. `normalizeProjectState` 不改：它仍就地规范化「物化字段」。重放是**额外的**加载步骤，只在 `normalizeProject` 里做一次。
3. journal 为空（`{}` 测试对象）时，动词仍照常物化字段 —— 因为 `commit` 会把事件写进懒建的 `project.projectionJournal` 并折叠物化。测试对象多出一个数组字段，不影响任何断言。
4. checkpoint 在保存前压实，把日志尾折叠进 `project.projectionCheckpoint` 并清空尾，保证存储有界。
5. `restoreProjectProjections` 只在 `normalizeProject` 调用；当 checkpoint 行 `ver` 失配或缺失时，从 `init` 重放完整尾日志（fail-closed：重放报错就把该 key 的 `failure` 置位，`readGoal` 抛错而不是静默返回脏值）。

### 3.4 测试策略

- 纯折叠：`apply` 对无关事件返回**同一引用**（`assert.equal(state, next)`）。
- 整值语义：`goal/change` 只带完整快照，折叠后即为该快照。
- 引用稳定性：连续两次 `restore`/`normalizeProjectState` 不改动已合法 `project.goal` 的引用。
- 重放：checkpoint + 尾日志 = 从头重放，结果一致。
- stateVersion 失配：旧 checkpoint 行被丢弃并全量重放。
- 变更抑制：`commit` 一个与当前 view 等价的事件不触发物化（domain revision 不 bump）。
- turn 边界：`turn/start` 后 `open=true`，`turn/end` 后 `open=false`；无开启回合时审批 fail-closed。

### 3.5 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 加载时重放造成对象引用变化 → 无限重渲染 | 重放只在 `normalizeProject`（一次性加载）；渲染路径不重放；`normalizeProjectState` 引用稳定性测试继续守护 |
| 整项目 JSON 变大 | 保存前 checkpoint 压实 + 尾日志上限，超出即压实 |
| 日志与物化字段分叉 | 加载时日志优先；分叉即视为「上次未干净退出」，以日志重放为准 |
| `{}` 测试对象没有 journal | host 懒建；动词仍然物化字段，行为对断言透明 |

---

## 4. P2 Goal Reservation & Checkpoint

对应 Harness `goal-round-driver` 的 `DriverState` / `RoundAttempt` / `validReservation` / `competingQueued`。

### 4.1 设计（`app/adapters/agentSession.ts`）

新增会话闭包态：

```
type GoalRoundAttempt = {
  goalId: string; revision: number; round: number;
  conversationId: string; model: string; content: string;
  phase: 'queued' | 'admitted'; stale: boolean;
}
```

- **checkpoint-before-drive**：`scheduleGoalRound` 在 `takeGoalRound` 成功、真正投递续行指令**之前**，先 `await checkpointProjectNow()`（物化 + 立即落盘）。保证「已消耗的轮次」在任何模型回合开始前已经持久化，崩溃不会丢预约。
- **competing-queued 检测**：若此刻 `deliveryQueue` 非空（有别的消息在排队），**不**预约本轮（`competingQueued`），留给排队消息；预约派出后若有新的排队消息到达，把 attempt 标 `stale`。
- **validReservation 校验**：`drain` 在真正 `send` 一条续行投递前校验：attempt 存在、未 stale、目标仍 `active`、`goal.id/revision` 与预约一致、`round === goal.roundsStarted + 1`。任一不满足 → 取消该 attempt、按需 disarm，不派发。
- **停用点**：运行失败、用户停止、目标非 active、达上限、预约失效 —— 都立即 `goalDriverArmed=false` 并清 attempt。

### 4.2 文件清单

| 操作 | 文件 |
| --- | --- |
| 修改 | `renderer/src/app/adapters/agentSession.ts` |
| 修改 | `renderer/src/store/projectStore.ts`（导出 `checkpointProjectNow`） |
| 修改 | `tests/agent-goal-rounds.test.mjs`（补 reservation/checkpoint 断言） |

### 4.3 测试策略

- 目标续行消耗轮次后**先落盘**再派发（用注入的 persist 探针断言顺序）。
- 有 competing 排队消息时不预约。
- 预约后目标被 pause/complete/revision 变化 → 该轮不派发。
- 达上限 → 不派发、disarm、给出可见收手消息。

---

## 5. P3 Approval Waterfall

### 5.1 设计

新增 `renderer/src/agent/runtime/approvalWaterfall.ts`：

```
type ApprovalPolicy = 'ask' | 'never'
type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
resolveApprovalPolicy(): ApprovalPolicy          // 服务层唯一判定，读设置
requestApproval(request): Promise<ApprovalResolution>
```

`requestApproval` 的顺序（承重）：

1. **服务层先判策略**：`policy === 'never'` → 立即返回 `rejected`，**不派发任何监听器**。（硬约束：不能靠监听器排序实现 'never'。）
2. **回合边界前置检查**：从 `context.state` 的会话投影 host 读 `turnBoundary`；无开启回合 → fail-closed 返回 `unavailable`（拒绝），并**不**写半截审计对。
3. 写审计对 `approval/asked` → 派发交互确认 → 写 `approval/decided`。审计事件通过运行事件出口落盘，天然在 `runId` + `turnId` 内。
4. **归一化**：交互返回不在词表内 → `unavailable`；抛异常 → `unavailable`（问题失败关闭，而不是让调用方静默放行）。

`executeToolCall.ts` 的两处内联确认（policy==='confirm' 与 `approvalRequired`）合并为一次 `requestApproval` 调用；`policy==='deny'` 仍然最先短路。

### 5.2 文件清单

| 操作 | 文件 |
| --- | --- |
| 新增 | `renderer/src/agent/runtime/approvalWaterfall.ts` |
| 修改 | `renderer/src/agent/runtime/executeToolCall.ts` |
| 修改 | `renderer/src/store/settingsStore.ts`（`agentApprovalPolicy: 'ask' \| 'never'`，默认 `'ask'`） |
| 新增 | `tests/agent-approval-waterfall.test.mjs` |

### 5.3 测试策略

- `never` 策略下：不发出 `interaction_requested`、直接拒绝、审计对仍有 `asked`+`decided`。
- 无开启回合：fail-closed 拒绝，且**不**写审计对。
- 监听器抛异常 → `unavailable` 拒绝，不放行。
- `ask` 策略正常批准/拒绝/改参路径与现有 `agent-loop` 行为一致。
- 审计事件与确认事件同属一个 `turnId`。

---

## 6. P4 Tool Pipeline Stages（本阶段暂缓）

Harness 把单次工具调用拆成 `prepare / dispatch / finalize`，并在阶段间放「动态重分类屏障」与并行调用的 context 隔离。Shotloom 的 `executeAgentToolCall` 已隐含这三段（prepare=校验+权限；dispatch=execute；finalize=回执记账），但显式拆分收益集中在「并行只读调用的 context 隔离」——而 Shotloom 已把并发收窄到纯只读、并把共享容器在派发前固定，风险已受控。**本阶段不实施**，只在 P1–P3 完成后评估是否需要。若实施，落点仍是 `executeToolCall.ts` 单文件，不新增转发层。

### 不迁移的 LOW 项

- **Frozen Messages**：Shotloom 的历史裁剪用整组丢弃（`fitTranscript`），已经不是逐条改写，冻结消息带来的收益（避免缓存前缀失效）在当前实现里不成立。
- **Inbox Splices**：Shotloom 的 inbox 是 `deliveryQueue` + 单轮 steering，语义已清晰；引入 splice 只会多一层间接。
- **Runtime Context**：Shotloom 的 `buildRunContextBlock` 已按轮装配，无 Harness 那种长驻 system 前缀，收益不明确。

---

## 7. 总测试与门禁

每完成一个优先级：

```
npm run check     # typecheck + check:layers + check:styles + check:tests + 612 tests
```

新增测试必须走 `tests/helpers/sourceContract.mjs` / `rendererSsr.mjs`（`check:tests` 强制），不得自拼 `readFileSync`。

## 8. 无法在无头环境完成的验证

真实 Tauri 窗口的端到端验证（`/goal`、`/plan`、`exit_plan_mode`、多轮自动续行、崩溃恢复后状态一致性）必须由用户在桌面端执行；本计划提供可复现的手动步骤清单（见 `docs/architecture/deepseek-harness-verification.md`）。
