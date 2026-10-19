# DeepSeek Harness 架构迁移验证报告

> 计划文档：`docs/architecture/deepseek-harness-migration-plan.md`
> 参考实现：`/Users/xiaomao26_1_12/projecets/deepseek-harness-master/packages/{session,goal,interaction}`
> 结论：P1（Session Projection）、P2（Goal Reservation & Checkpoint）、P3（Approval Waterfall）已实现并通过全部门禁；
> P4（Tool Pipeline Stages）与三个 LOW 项按计划不实施。

---

## 1. 迁移范围

| 优先级 | 特性 | 状态 | 落点 |
| --- | --- | --- | --- |
| 🔴 P1 | Session Projection System | 已实现 | `renderer/src/store/projectProjections.ts`（新增）、`services/agentConversations.ts`、`store/projectNormalization.ts`、`store/projectStore.ts` |
| 🔴 P2 | Goal Reservation & Checkpoint | 已实现 | `renderer/src/app/adapters/agentSession.ts`、`store/projectStore.ts` |
| 🔴 P3 | Approval Waterfall | 已实现 | `renderer/src/agent/runtime/approvalWaterfall.ts`（新增）、`agent/runtime/executeToolCall.ts`、`store/settingsStore.ts`、`agent/loop/agentLoop.ts` |
| 🟡 P4 | Tool Pipeline Stages | **未实施**（计划中暂缓） | — |
| 🟢 LOW | Frozen Messages / Inbox Splices / Runtime Context | **未迁移**（计划中说明收益不成立） | — |

**总原则未破**：迁移是在 `domainReactivity` 之下插入一层事件日志，`domainReactivity` 仍是唯一的对外变更通知机制；渲染路径仍读 `project.goal` / `project.planMode`，没有引入第二条订阅通道或无限重渲染。

---

## 2. 文件清单

### 新增

| 文件 | 职责 |
| --- | --- |
| `renderer/src/store/projectProjections.ts` | 投影契约（`ProjectionDefinition`）、模块级 registry、项目/会话宿主、整值事件折叠、checkpoint/restore、`turnBoundary` 会话投影 |
| `renderer/src/agent/runtime/approvalWaterfall.ts` | 审批服务层唯一实现：策略解析、回合边界、`requestApproval`、审计对 |
| `tests/agent-project-projections.test.mjs` | P1 引擎行为契约 |
| `tests/agent-approval-waterfall.test.mjs` | P3 审批服务层契约 |
| `tests/agent-goal-rounds.test.mjs` | P2 持久轮次 + 预约/复核/checkpoint 契约 |

### 修改

| 文件 | 变更 |
| --- | --- |
| `renderer/src/services/agentConversations.ts` | 注册 `goal` / `planMode` 投影与物化；CAS 动词改为提交整值事件；`readGoal`/`isPlanMode` 读物化字段 |
| `renderer/src/store/projectNormalization.ts` | `createProject` 初始化 `projectionJournal`/`projectionCheckpoint`/`projectionSeq`；`normalizeProject` 调 `restoreProjectProjections` |
| `renderer/src/store/projectStore.ts` | 持久化快照前 `checkpointProjectProjections`；导出 `flushProjectCheckpoint` |
| `renderer/src/store/settingsStore.ts` | 新增 `agentApprovalPolicy: 'ask' \| 'never'`（默认 `'ask'`），随 `applySettings`/`toPlainSettings` 规范化 |
| `renderer/src/agent/runtime/executeToolCall.ts` | 两处内联确认（`policy==='confirm'`、`approvalRequired`）合并为一次 `requestApproval` |
| `renderer/src/agent/loop/agentLoop.ts` | 每步 `openAgentTurn(context, step)` + `finally closeAgentTurn(context)` |
| `renderer/src/app/adapters/agentSession.ts` | P2 预约态、`scheduleGoalRound`、`admitGoalRound`、stale 标记、checkpoint-before-drive |
| `AGENTS.md` | 新增「项目级事件溯源投影」章节；长期目标章节补预约/复核/落盘契约；运行引擎章节补审批瀑布与回合边界契约 |

---

## 3. 契约不变量与验证落点

### P1 事件溯源投影

| 不变量 | 验证 |
| --- | --- |
| `apply` 同步、纯，无关事件与同值事件返回**同一引用** | `apply 是纯折叠：无关事件与同值事件都必须返回同一引用` |
| 整值事件折叠后即完整快照并物化回宿主字段；`seq` 单调递增 | `整值事件折叠后即为携带的完整快照，并物化到宿主字段` |
| 等价事件被抑制，不写物化字段、不 bump domain revision；真实变化仍触发一次通知 | `与当前 view 等价的事件被 apply 抑制，不触发物化与领域通知` |
| checkpoint 压实尾日志；checkpoint+尾重放与全量重放结果一致 | `checkpoint 压实尾日志，checkpoint + 尾重放与全量重放结果一致` |
| `stateVersion` 失配的 checkpoint 行被丢弃并全量重放 | `stateVersion 失配的 checkpoint 行被丢弃并全量重放尾日志` |
| 只有存在日志/checkpoint 证据时以日志为准物化；legacy 项目保持字段原样 | `restore 只在存在日志/checkpoint 证据时以日志为准物化字段` |
| 会话作用域投影（`turnBoundary`）**不进**项目 checkpoint | `会话作用域的回合边界投影不进项目 checkpoint` |
| `turn/start` → `open=true`；`turn/end` → `open=false`；重复闭合返回同一引用 | `turn 边界投影：开启后 open=true，闭合后 open=false，重复闭合幂等` |

### P2 目标续行预约

| 不变量 | 验证 |
| --- | --- |
| `takeGoalRound` 只在 `active` 且未达上限时把 `roundsStarted+1` 并增 `revision` | `takeGoalRound 只在进行中目标上推进持久轮次并递增 revision` |
| 达上限后收手、不再凭空增 `revision` | `轮次达上限后 takeGoalRound 收手且不再改写目标` |
| 非 active / 已清除目标不被推进 | `非 active 与已清除的目标不会被自动续行推进` |
| 会话层只推进已有目标且在停用点收手，绝不凭空创建目标 | `会话层自动续行只推进已有目标并在停用时收手` |
| 派发前先 `flushProjectCheckpoint` + `admitGoalRound` 复核；competing 排队消息顶掉本轮；预约轮次与持久 `roundsStarted` 对齐；作废后清空预约 | `续行派发前先落盘并复核预约，competing 排队消息顶掉本轮` |

### P3 审批瀑布

| 不变量 | 验证 |
| --- | --- |
| 回合边界帮助函数开启/闭合幂等 | `回合边界帮助函数：开启/闭合幂等，闭合后不再是开启回合` |
| `'never'` 服务层就地拒绝：不派发 `interaction_requested`，但审计对（`approval_asked`+`approval_decided`）完整 | `never 策略在服务层就地拒绝：不派发确认，但审计对完整` |
| 没有开启回合时失败关闭，且**不写任何**审计事件 | `没有开启回合时失败关闭，且不写半截审计对` |
| `ask` 批准走 `allowed-once`，审计与确认事件同属一个回合 | `ask 策略正常批准走 allowed-once，审计与确认事件都落在同一回合` |
| 用户拒绝走 `rejected`，拒绝原因回给调用方 | `用户拒绝走 rejected，拒绝原因回给调用方` |
| 答者失败（过期/异常）失败关闭，绝不静默放行 | `答者失败（过期/异常）失败关闭，绝不静默放行` |
| step 模式批准回执携带工具步骤结果 | `step 模式的批准回执携带工具步骤结果，拒绝则回执失败` |

### 未变更契约（回归守护）

- `tests/agent-loop.test.mjs`：审批流与每轮 `turn_start` 计数（2 步运行恰好 2 次）仍成立——回合边界只经 `commitProjectionEvent` 写投影，不派生额外 runtime 事件。
- `tests/agent-conversations.test.mjs`：goal/planMode 的 CAS 语义与对外形状逐字不变。
- `tests/agent-plan-mode.test.mjs`：`exit_plan_mode` 的人工确认与可见性不变。

---

## 4. 测试与门禁结果

在执行迁移后于本机运行：

```
npm run check
# tsc --noEmit -p tsconfig.json                              → 通过（无类型错误）
# node scripts/verify-module-discipline.mjs  (check:layers)  → 通过（321 个源文件）
# node scripts/verify-styles.mjs             (check:styles)  → 通过（17 张样式表，278 个具名色阶）
# node scripts/verify-test-architecture.mjs  (check:tests)   → 通过（108 个测试文件）
# node --test tests/*.test.mjs                               → 628 pass / 0 fail
```

- 迁移前基线：**612 pass**。
- 迁移后：**628 pass**（新增 16 条：P1 8 条、P3 7 条、P2 1 条），**0 fail**。
- 结论：未破坏任何既有测试；新增测试覆盖的全部为持久化与安全边界（可重放性、竞态消除、失败关闭），未把模型职责写成断言。

---

## 5. 范围说明与已知取舍

1. **审批策略不注入 system prompt**：`agentApprovalPolicy` 是设置层的确定性立场，当前不向模型播报"当前是 never 模式"。模型收到的仍是可恢复的工具拒绝回执（"需要审批的操作被自动拒绝"）。若后续希望模型据此改变计划（例如改走只读路径），可在 `content/instructions.ts` 增加一处注入；这是有意的范围决策，不是遗漏。
2. **`'never'` 与 `agentShellApproval` 语义分离**：`agentShellApproval='ask'` 决定"哪些副作用要问"，`agentApprovalPolicy='never'` 决定"到底还问不问"。二者默认值分别为 `'full'` 与 `'ask'`，因此默认行为与迁移前一致（仅对写类关键工具按策略询问；`approvalRequired` 工具始终询问）。
3. **审批事件是新的 runtime 事件类型**：`approval_asked` / `approval_decided`。`projectAgentRun` 与 `AgentRuntimePresenter` 通过兜底分支忽略它们，不影响运行状态推导（`agent-loop.test.mjs` 未受影响）。
4. **P4 未实施**：`executeAgentToolCall` 已隐含 prepare/dispatch/finalize 三段，且并发已收窄到纯只读，显式拆分收益有限。若未来实施，落点仍是 `executeToolCall.ts` 单文件，不新增转发层。

---

## 6. 无法在无头环境完成的验证（需用户桌面端执行）

以下端到端验证依赖真实 Tauri 窗口、真实模型凭证与真实磁盘目录，**必须由用户在桌面端手动执行**。每步给出可观察的判定标准。

### 6.1 计划模式与目标（回归）

1. 在输入框执行 `/plan 把这条短片剪成 30 秒横屏版本`。
   - 判定：本地回执出现，且请求以计划模式发送；模型只做只读调研，不直接改动画布。
2. 让模型产出方案后，触发 `exit_plan_mode`。
   - 判定：先弹出确认卡；**拒绝**后仍是计划模式、可继续打磨；**批准**后 `planMode` 关闭并放行执行。
3. 执行 `/goal 把这条短片做完`，然后让第一轮正常结束。
   - 判定：出现"目标自动续行：第 N/M 轮"消息，并自动链接下一轮。

### 6.2 P2 目标续行竞态（新）

4. 在自动续行链接的**间隙**（两轮之间、队列空闲）向输入框发送一条普通消息。
   - 判定：普通消息先执行；被顶掉的续行预约不派发，`roundsStarted` 不因此多计一轮。
5. 在续行跑起来后按停止。
   - 判定：续行链立即终结，即使此刻没有活跃请求也不再武装。

### 6.3 P2 checkpoint-before-drive（新，崩溃恢复）

6. 让目标续行进入某一轮（日志已打印"第 N 轮"），在模型回合进行中**强制退出进程**。
   - 判定：重启并重新打开项目后，`roundsStarted` 至少为 N（已消耗轮次不回退），已持久化的目标状态与轮次一致。
7. 手动把项目 JSON 里的 `projectionJournal` 制造为非空、把 `project.goal` 物化字段改成明显错误的值，重新打开项目。
   - 判定：加载时以日志重放为准，`project.goal` 被纠正回日志推导值（日志优先于陈旧物化字段）。

### 6.4 P3 审批瀑布（新）

8. 把设置 `agentApprovalPolicy` 切到 `never`（需要界面/调试入口），然后让 Agent 发起一个本来需要审批的工具（例如 `connect_nodes`）。
   - 判定：**不弹出**确认卡；工具回执是"被自动拒绝"；Agent 收到可恢复失败并能改走别的方案，不静默执行。
9. `agentApprovalPolicy` 保持 `ask`，正常触发一次审批。
   - 判定：确认卡出现；批准后执行、拒绝后返回拒绝原因。
10. 触发一次审批后，在确认卡出现时按停止（中断）。
    - 判定：运行以取消路径结束（不是"用户拒绝"），审计对里有 `cancelled`。

### 6.5 P1 turn 边界（新，契约观察）

11. 让 Agent 跑一次包含工具调用的两步运行，检查运行轨迹。
    - 判定：`turn_start` 恰好按步骤数出现（未因回合边界多出事件）；审批/工具事件都归属到对应回合。

---

## 7. 复现环境

- 分支：`develop`
- 命令：`npm run check`（typecheck + check:layers + check:styles + check:tests + 628 tests）
- 本报告所有自动化结论均来自上述命令的真实输出，未做任何人工推断替代。
