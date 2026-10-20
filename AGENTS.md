# Shotloom Agent Engineering Guide

## 核心原则

Shotloom 的 Agent 以模型为决策主体。不要在应用代码中用关键词、正则、文本长度、数量阈值或枚举穷举去猜测用户意图、制作范围、任务复杂度和内容质量。

- 模型负责理解用户完整语义、选择工作流、拆分任务、规划依赖、判断是否需要追问，以及评估交付是否充分。
- 用户表达明确时直接继续，不得因为缺少某个内部状态字段而重复询问。
- 用户表达确实会导致多个显著不同结果时，由 Router 使用 question 工具集中澄清。
- Prompt、Skill、Contract 和 AGENTS.md 用来约束 Agent 的工作方式；不要把开放式工作流要求改写成阻塞所有工具的代码门禁。
- 工具回执应把可恢复的问题返回给 Agent，让 Agent 修正后继续；不要因一个可修复的规划瑕疵让整轮运行失败。

## 代码应该强制的边界

代码只强制执行无法安全交给模型自行保证的客观边界：

- 权限与用户设置，例如关闭“允许 Agent 运行节点”后不得启动生成。
- 付费、删除、覆盖、外部发送等不可逆或有成本的操作边界。
- 数据真实性，例如节点、任务、文件和工具回执是否真实存在。
- 数据存储的基本完整性，例如目标记录存在、标识可稳定引用、写入结构可以持久化。
- 完成声明必须有真实结果或成功工具回执支持。

这些校验应尽量返回具体、可操作的信息。可以安全修复的数据应规范化并附带 warning，不应直接终止 Agent。

## 代码不应该强制的判断

以下内容属于 Agent 的认知和制作职责，默认不得写成硬编码门禁：

- 根据用户文字判断“只规划”“规划并执行”“分析”或其他意图。
- 根据文本长度、时码数量或节点数量判断是否必须创建计划。
- 强制一个时间段对应一个视频节点、一个文本节点不能代表若干工作项等制作质量规则。
- 强制工作项数量、阶段数量、镜头数量或固定拆分粒度。
- 因规划依赖写错、提示词暂缺或后续阶段尚未展开而拒绝保存整个计划。
- 在用户已经明确要求后，仍要求先回答内部的 production scope 或 capability 问题。

这类问题应在 Agent Contract 中说明目标和质量标准，由模型根据实际内容处理，并在工具回执出现 warning 时自行修正。

## 分层约定

- Router：理解用户意图，选择工作流，必要时提问。
- Planner：形成可调整的计划和工作项，不拥有执行权限。
- Executor：通过真实画布工具实施计划，遵守用户设置和工具权限。
- Reviewer：依据真实节点、任务、文件和回执核验结果。
- Runtime/Store：传递状态并保存事实，不替 Router 或 Planner 做语义判断。

保持分层清晰，但不要为了分层创建只有几行转发逻辑的文件或函数。优先让一个模块完整拥有一项职责。

## 状态引擎

`renderer/src/store/domainReactivity.ts` 与 zustand 各自只服务一类状态，新增第三种引擎必须先改这份契约：

- 领域与持久状态（工程、节点、任务、设置、Skill、模板、素材库）只用 domainReactivity：状态对象就地可变，改动合并成一次 revision 通知，界面用 `useSyncExternalStore(subscribeDomain, getDomainRevision)` 订阅。画布写入量密集，改成不可变快照会付出无收益的复制成本。
- 界面状态（窗口、浮层、会话运行态）只用 zustand，并且只允许出现在 `app/` 与 `vendor/`。`store/`、`services/`、`agent/`、`domain/` 里出现 zustand 依赖即视为把领域状态搬进界面引擎。
- 唯一登记例外：`store/notificationStore.ts`。提示条必须能被数据层触发，所以它住在 store 层，但仍然是界面状态。
- `app/store/` 不得引入 domainReactivity；`store/` 下的纯函数模块（节点、边、步骤等图数据访问器）不携带引擎，只读写 projectStore 的同一份可变对象。
- 以上边界由 `scripts/verify-module-discipline.mjs` 检查（`npm run check:layers`）。新增例外必须在该脚本的集合里显式登记并说明理由。

## 项目级事件溯源投影

`renderer/src/store/projectProjections.ts` 是 domainReactivity 之下的一层，不是第三个状态引擎：真相是只追加的整值事件日志，派生状态是对它的纯折叠，折叠结果只物化回项目字段再由 domainReactivity 合并通知。对外变更通道仍然只有 domainReactivity 一条，渲染路径照旧读物化字段，不引入第二套订阅。

- `ProjectionDefinition.apply(state, event)` 必须同步、纯，且对本单元无关的事件**返回同一引用**（`Object.is`）；引用不变即零下游开销、不物化、不 bump revision。事件是整值事件，携带变更后的完整状态，不是增量；单元状态必须是普通 JSON（checkpoint 的前提）。
- 注册是 fail-closed 的：同 key 同 `stateVersion` 重复注册是幂等空操作，同 key 不同 `stateVersion` 直接报错。没注册的 key 在快照里不存在，读它就是能力缺失。
- 宿主分作用域：`scope: 'project'` 的日志与 checkpoint 落在 `project.projectionJournal` / `project.projectionCheckpoint` / `project.projectionSeq`，随项目 JSON 持久化；`scope: 'session'` 的运行态投影（如 `turnBoundary`）只活在内存里，**绝不进 checkpoint 行**。物化必须经调用方传入的原始对象（可能是 domainReactivity 的 Proxy），否则不会触发合并通知。读写 journal / seq 本身一律走 `toRaw` 后的普通对象，折叠运算不得被 Proxy 干扰引用判定。
- 加载与创建路径各做一次：`createProject` 初始化空 journal/checkpoint；`normalizeProject` 调用 `restoreProjectProjections` 重放。**只有存在非空日志或 checkpoint 证据时**才以日志为准重建并物化字段，二者都空（legacy 项目）时不动物化字段，交给 `normalizeProjectState` 的就地规范化。重放**绝不放渲染路径**。保存前 `checkpointProjectProjections` 把尾日志压进 checkpoint 行并清空尾，保证存储有界。
- 当前注册的投影：`goal`（`goal/change` → `project.goal`）、`planMode`（`plan/change` → `project.planMode`）为项目作用域；`turnBoundary`（`turn/start` / `turn/end`）为会话作用域。注册与物化分别在 `services/agentConversations.ts` 与投影引擎里，不得在界面另起一套。

## Agent 画布写入路径

Agent 对画布的写入只有一条路径，三层各自拥有完整职责，不得再插入注册表、handler 分发层或只有转发动作的中间文件：

- `agent/tools/canvasTools.ts`：工具入口、输入 schema 与批次归一化。
- `services/agent/agentCanvasExecutor.ts`：批次事务——项目围栏、跨批次持久 tempId 映射、journal 与画布历史、预检、布局与批次回执。
- `services/agent/agentActionHandlers.ts`：单个动作的唯一落点，按 `switch (action.type)` 显式列出契约类型，未知类型返回可恢复回执。

`ActionHandlerContext` 只暴露项目本体与引用解析（`project`/`tempIdMap`/`resolveNode`/`resolveNodeId`/`defaultNodePosition`）。动作实现不得接收宽松的 `Record<string, any>` 上下文，也不得自己解析 tempId 或语义别名——那会绕过执行器的跨批次映射。

`connect_nodes` 与 `create_gen_node.inputLinks` 必须共用同一个输入边写入函数：角色由 `validateAgentInputRole` 解析，能力与槽位由模型目录决定，最后落到 `addCanvasEdge({ kind: 'typed-input', data: { inputRole, inputSlot, required } })`。两个入口写出不同的边结构就是缺陷。

## Agent 对外接口与运行状态

- Agent 的可见性解析、执行策略、运行事实与模型循环（`agent/core/visibility`、`core/policyEngine`、`core/runFacts`、`core/toolIdentity`、`agent/loop/`）是引擎内部实现。界面只消费声明入口：`agents/definitions`、`core/toolRegistry` 的展示元数据、`core/skillAssignments`、`runtime/` 与 `tools/` 导出的解析函数。界面自己拼 `selectAgentSkills(agentDefinition(id), enabled)` 会复制一层调用约定并产生与运行时不同的结果，输入框选择器必须调用 `availableAgentSkills(agentId)`。
- 唯一的登记例外：`app/adapters/agentSession.ts` 驱动 `agent/loop/runLoopAgent`，它是 app 与运行引擎之间的会话边界单元。
- Agent 的运行状态只有一份归属：`runtime/runStore` 保存真实运行与会话事实，`app/adapters/agentSession.ts` 持有面板运行态（忙闲、活跃请求、待投递队列、steering）。适配层与界面组件不得再各自留一份"现在忙不忙"之类的模块级单例。

## Agent 定义与工具可见性

`renderer/src/agent/agents/definitions.ts` 是每个 Agent 的工具、Skill、副作用上限和可派发子 Agent 的唯一来源。会话记录用 `agentId` 表明归属，运行时不得再从 `editorNodeId`、工具名前缀或界面作用域反推 Agent 身份。

- 工具白名单是 fail-closed 的：新工具没有列入任何 Agent，就对所有 Agent 不可见——既不进入模型请求，也无法在本地执行。禁止改回 deny 黑名单或“默认可见再加例外”的写法。
- `effects` 是独立于白名单的第二层副作用上限，用来表达“这个 Agent 原则上不能造成某类改动”。新增副作用类别时必须同时更新白名单与上限，不能只加一处。
- Skill 归属只在 Agent 定义里声明。运行时请求组装、执行时的 Skill 事件回写和输入框选择器必须消费同一份解析结果；不要在别处恢复 `'general' | 'video-editing'` 这类作用域字符串。
- 子 Agent 只能由主 Agent 的 `dispatch` 显式授予；契约文件的 `appliesTo` 只能引用已声明的 Agent id 或 `'*'`。
- 自研 Agent loop（`renderer/src/agent/loop/`）每一步都按当前 `agentId` 重新解析可见集：子 Agent 只看得见自己定义里的工具与 Skill，父 Agent 的画布写权限不会随派发继承。
- 修改可见性必须覆盖五类失败：未列入白名单的新工具、超出副作用上限的写工具、`isAvailable` 关闭、Skill 未加载、未知 Agent id。

## 运行引擎与执行管道

- `renderer/src/agent/loop/runLoopAgent.ts` 是唯一的 Agent 运行入口：模型循环、会话历史、上下文裁剪与子 Agent 全部由自研 loop 驱动，没有第二个引擎，也没有引擎选择层。
- loop 支持模型目录明确声明的 OpenAI Chat Completions、OpenAI Responses 和 Anthropic Messages。`loop/modelRequest.ts` 的 `loopUnsupportedReason(model)` 是协议能力的唯一判断：声明的协议与 endpoint 不匹配时，本轮直接以诊断失败结束，不得把请求降级成“语义相近但不同”的协议，也不得用 `localStorage` 之类的开关绕过目录。三种协议只在请求与流式响应边界转换，内部会话历史与工具执行管道仍共用一份。
- 执行管道 `runtime/executeToolCall.ts` 只有一份实现：权限确认、重复调用拦截、用户改参重校验、回执记账和 `tool_start`/`tool_end` 事件，loop 不得自行调用 `definition.execute`。
- 审批（user-approval）只有一份服务层实现 `runtime/approvalWaterfall.ts`，工具管道与循环都只能经 `requestApproval`，不得各自内联确认卡。顺序是承重的：回合边界前置检查 → 写 `approval_asked` → **服务层就地判 `'never'` 策略**（拒绝，不创建交互、不发 `interaction_requested`）→ 派发确认 → 写 `approval_decided`。`'never'` 的判定绝不能靠监听器或注册顺序（后注册的拦截器不能放行一次注定被拒的提问）；没有开启回合时失败关闭（`unavailable`）且**不写半截审计对**；确认抛异常、非词表返回值一律归一化为失败关闭，绝不让调用方静默放行。中断（`AbortError`）写审计 `cancelled` 后**原样重抛**，不得伪装成一次普通"用户拒绝"。
- 审批策略与"哪些操作要问"是两件事：`agentShellApproval`（`'ask'|'full'`）决定哪些副作用要问，`settingsStore.agentApprovalPolicy`（`'ask'|'never'`，默认 `'ask'`）决定到底还问不问。`'never'` 不是自动放行——它是无人值守立场：需要审批的操作一律自动拒绝。两处确认（`policy==='confirm'` 与工具自己声明的 `approvalRequired`）都走同一次 `requestApproval`；`policy==='deny'` 仍最先短路。
- 审批的审计对必须落在一次已开启的模型回合内，否则与崩溃尾巴无法区分。回合边界是 `turnBoundary`（会话作用域投影，只活在内存里）：loop 每一步 `openAgentTurn(context, step)` 开启、在 `finally` 里 `closeAgentTurn(context)` 闭合，无论这一步如何结束都不留半开回合。边界只经 `commitProjectionEvent` 写投影，**不得**额外派生 runtime 事件（否则会改变 `turn_start` 计数契约）。审批服务的会话宿主挂在 `context.state` 的 `sessionProjectionHost` 键上，与工具管道同一份。
- 提示词装配（`content/instructions.ts`）、附件转图片（`content/attachments.ts`）、运行失败诊断（`runtime/runtimeDiagnostics.ts`）和终态结果推导同样只有一份实现。诊断只按模型请求与本地运行环境的真实错误文本分类，不得为某个外部进程的实现细节分类。
- `skill` 与 `dispatch_subagent` 是 loop 自带的循环机制，不进工具注册表；其可见性完全来自 Agent 定义的 `skills`/`dispatch`，为空就没有该工具。
- loop 与 `context.emit` 必须是同一个事件出口：循环为每一轮（主 Agent 与每个子 Agent）派生一个带身份的事件出口，同时用作 `input.emit` 和工具管道的 `context.emit`。测试或调用方不得把它们拆成两条通道，否则权限确认与工具事件在界面上消失。
- 每条 runtime 事件都带 `agentId`（谁在执行）与 `agentSessionId`（主 Agent 用 requestId，子 Agent 用派发时生成的 childSessionId）。`subagent_*` 事件用 `childAgentId` 表示被派发的 Agent，不得复用 `agentId`，否则发出方与对象的身份会互相覆盖。身份缺失或不一致会让事件在 `agentRuntimeEvents` 里无法归属。
- 运行轨迹按 `agentSessionId` 分组显示"谁在执行"：主 Agent 的步骤平铺，子 Agent 的派发是一条标题行，它的步骤挂在它下面。分组的顺序来自事件真实到达顺序，界面不得从工具名或文本猜测执行者，也不得把子 Agent 的回执并入父级步骤。子 Agent 标题显示 `childAgentId` 对应的真实 Agent 名；`childAgentId` 无法解析成已声明的 Agent 时只显示通用文案，不得挑一个相近的名字冒充。
- 卡住检测由 `loop/stallWatchdog.ts` 负责，唯一的进展依据是事件出口有没有动静：静默 180 秒提示"可继续等待或停止"，超过 30 分钟改成长时运行提示，恢复只报一次。看门狗只通知不中止运行，单轮模型请求的超时仍由 `MODEL_REQUEST_TIMEOUT_MS` 负责，看门狗自身的提示事件必须走原始事件出口，不能重置自己的静默计时。
- 循环不设步数或轮次上限，合法的长任务必须一直跑下去。跑飞由"有没有进展"判定：一轮里出现的调用参数指纹（与 LoopGuard 同一套归一化）在本轮运行中是新的，或这一轮的回执证明项目真被改动，都算进展；连续 `STALLED_ROUND_LIMIT` 轮既不试新调用也不改动项目才失败，并说明是哪几类重复。判定只看本地真实痕迹，不猜任务复杂度，也不猜用户意图。剩下的兜底是权限与确认边界、单轮模型超时、看门狗提示和用户停止，不得再把固定步数当成安全网。
- 中断留下的无应答工具调用必须补齐后才能落盘，补写内容只按本地真实痕迹分档：有回执且回执证明改动了项目 → 不得重试；已开始派发但无回执 → 影响未知，先只读核验；上一次未正常退出的运行遗留 → 同样只能声明影响未知；本轮确实没派发 → 才可以说"没有产生任何效果"。派发点必须记账（管道在 `execute` 前、循环在 `builtin.run` 前），等待用户确认时被中断不算已派发。
- 超长工具结果只由 `loop/toolOutputSpill.ts` 一份实现处理：超过阈值就把完整回执写进 `<projectDir>/.shotloom/agent-spill/`，历史只留头尾摘要和摘要里的 `callId`；读回只有 `read_tool_output`，它只按当前会话登记的 `callId` 取文件，不接受任意路径。因此每个 Agent 的白名单都必须授予它，模型才有办法看清被省略的内容。项目没有磁盘目录（浏览器预览）或写文件失败时只能退回"读不回来"的摘要，不得假装可以读回，也不得因此终止本轮。落盘索引随会话持久化并限制条数，超出上限的旧文件连记录一起移除。
- 模型凭证仍由 Rust 侧注入：渲染进程只传 `providerId` 与 endpoint 元信息，请求里不含接口地址与密钥，`__` 前缀字段在发请求前剥离。自研 loop 的模型请求与画布生成共用 `generation_request`/`generation_stream` 网关，不得为 Agent 新增放宽网关校验的命令。

## 长期目标与计划模式（/goal、/plan）

- goal 与 plan 是项目级持久状态，不是会话级：一个项目同时只有一个进行中的目标与一个计划模式开关。持久字段固定为 `project.goal`（规范对象或 `null`）与 `project.planMode`（严格布尔）。改它们只允许经 `renderer/src/services/agentConversations.ts` 里那一组 CAS 动词（`createGoal`/`editGoal`/`pauseGoal`/`resumeGoal`/`completeGoal`/`blockGoal`/`clearGoal`、`isPlanMode`/`setPlanMode`、`takeGoalRound`）——用户命令、模型工具与续行 driver 共用同一组动词，界面不得再维护第二套目标结构。每次成功变更 `revision` 递增，携带旧 `{id,revision}` 的调用被拒绝并回清晰错误，而不是覆盖更新的视图。
- 规范化只在保存/加载经 `normalizeProjectState` 做一次，且必须幂等：`planMode` 同值不写，`goal` 已是规范对象时保持原引用。渲染路径与 `ensure` 路径不得调用它——改写对象引用会每次 bump domain revision，触发无限重渲染。
- `app/store/goalPlanStore.ts` 是按 `agentId:conversationId` 分面板的 zustand 界面态，只持有输入草稿与斜杠面板状态，不得写 `project.goal` 或 `project.planMode`。
- 三条平面各负其职并汇聚到同一份 CAS 状态：用户斜杠命令层（`app/agent-chat/slashCommands.ts` 解析 + `app/adapters/agentChatAdapter.ts` 的 `runCommand`）、模型工具层（`agent/tools/goalTools.ts` 的 `get_goal`/`create_goal`/`update_goal`）、driver 自动续行层（见下）。命令层只改项目级状态并回一条本地结果消息；`/goal <目标>` 与 `/goal resume` 在空闲时启动目标 driver 的首轮，`/plan <正文>` 由界面把正文当作本轮真实请求发送，其余命令不发起模型请求。`create_goal`/`update_goal` 是 `agent_state_write`，默认不打扰用户。
- 提示词注入只有一个入口：`content/instructions.ts` 的 `buildGoalContext` 与 `buildPlanModeContext`，由 `runLoopAgent` 每步从 `store.project` 读最新值后随 system prompt 送出。计划模式改变的是这一轮该做什么，不裁剪任何工具；是否以只读调研为主由模型判断，应用代码不得据此阻塞写工具。
- 退出计划模式只有一条经用户裁决的路：`agent/tools/planTools.ts` 的 `exit_plan_mode`。它声明 `approvalRequired: true`，永远先在确认卡上请用户拍板——批准即把 `project.planMode` 置 `false` 并放行执行，拒绝则保持计划模式继续打磨方案。它是 `agent_state_write` 的项目级开关，不动画布、不启动生成；只授予三个主 Agent，子 Agent 一律不可见。不得把它改成阻塞所有写工具的应用层门禁。
- 自动续行只推进已有目标，绝不凭空创建目标。持久轮次 `roundsStarted` 的唯一落盘点是 `takeGoalRound`：只有 `phase=active` 且未达 `maxGoalRounds` 时才加一并随之 `revision` 递增，其余情况据实返回原因（`no-goal`/`inactive`/`round-limit`）且不写状态。是否"武装"续行是进程本地运行决策，只活在 `app/adapters/agentSession.ts` 的会话闭包里，不进持久 goal、不跨重启：一轮运行干净结束且项目仍有 active 目标时才武装；运行失败、用户停止（含两轮之间无活跃请求时按停止）、目标转为非 active 或轮次达上限都立即停用。每一续行轮的指令把"是否已达成或受阻"的判断交回模型（要求先只读核验，再 `update_goal` 的 `complete`/`blocked`），应用代码不替模型宣布完成。
- 自动续行用「预约 + 派发前复核」防止空耗与抢跑：`scheduleGoalRound` 在**有 competing 排队消息时不预约**；预约落定前先 `flushProjectCheckpoint()`（checkpoint-before-drive），落盘失败即收手、不假装成功；落盘期间目标被改、项目被切换或新消息排队都逐项复核，过不了就不预约。预约本身**不写** `roundsStarted`，只持有 `round = roundsStarted + 1`。
- 真正的持久轮次推进 `takeGoalRound` 从「排程时」移到「派发时」`admitGoalRound`：只有预约仍是当前这次（未被 `stale`）、目标仍是同一 `id/revision` 的 `active` 目标、且 `round === roundsStarted + 1` 时才 `takeGoalRound`（唯一落盘点），随即再 `flushProjectCheckpoint()` 保证"已消耗的这一轮"先于模型回合落盘——崩溃不会让轮次回退，复核不过的预约也不会白白消耗轮次。
- 有别的消息插到尚未派发的续行前面时，把该预约标 `stale`，`drain` 复核不过就不派发它；续行自己的投递不算 competing。运行失败、用户停止、目标转非 active、达上限或预约失效都立即收手并清空预约。
- 修改这类行为时，测试只验证持久不变量与安全边界（CAS `revision`、幂等规范化不触发重渲染、`roundsStarted` 单点落盘、派发前复核与 competing/stale 语义、checkpoint-before-drive 顺序、`exit_plan_mode` 的人工确认与可见性、续行只推进已有目标），不得把"目标该不该继续"这类模型职责写成断言。

## 厂商适配器与模型来源

`renderer/src/domain/provider/adapters/` 是厂商身份与传输层的唯一来源，和 Agent 工具白名单一样是 fail-closed 的：

- 厂商与协议由代码声明，模型能力只写在 `renderer/src/config/model-catalog-v2/<provider>.json`；`model-catalog-v2.json` 只保存厂商索引与全局模型顺序。界面不提供添加厂商、添加/编辑模型、停用模型和试跑入口；设置里每个内置厂商只能保存 API Key 与可选接口地址，其余配置一律不接受。
- 未在 `adapters/index.ts` 登记的厂商不存在：`getProviderAdapter` 直接失败，不回落到通用协议。支持新厂商 = 新增一个适配器文件并在注册表登记一行；只有协议形状无法用目录声明表达时（如 RunningHub 的素材上传 + 工作流提交）才自己实现 compile/submit/poll。
- 厂商把失败写在 HTTP 200 的响应体里时（MiniMax 全系的 `base_resp.status_code`），模式用 `errorCodePath` 声明状态码路径，非 0 即失败；说明文字默认取 `errorPath`，异步任务另有轮询错误路径时用 `errorMessagePath` 单独声明。不声明就按现有行为处理，不得在适配器里写厂商名判断。
- 适配器声明的 `baseUrl` 是唯一默认地址。`normalizeProviderConfigs` 在加载和保存时把"用户覆盖优先，否则内置地址"的实际生效值写回设置，Rust 网关只读设置中的 baseUrl，不再维护厂商地址表。加载时发现磁盘值与生效值不一致必须回写一次，否则原生层会读到缺失地址。
- 请求不得携带地址或密钥覆盖通道（`__baseUrl`/`__apiKey` 与 `GenerationRequest.base_url`/`api_key` 已删除）。`baseUrlRequired` 的厂商（Qwen 百炼）没有可内置地址，界面必须提示填写，不得用另一个语义相近的地址顶上。
- `ProviderConfig` 只含 `apiKey`/`baseUrl`。历史设置里的 `custom`、`models`、`disabledModelIds`、`displayName`、`iconId` 和未知厂商 id 在规范化时被丢弃，不写迁移兼容层。
- 厂商卡片里的模型清单只允许来自 `ModelAvailability.getProviderModelRows(providerId)`：类型分组顺序取自 `GENERATION_TYPES`，多模态标记取自各 mode 与 `inputVariants` 的 `inputConstraints`，"可用于 Agent"取自 Agent 目录的解析结果。界面不得另写一份厂商→模型表格，也不得用模型名称或版本号去猜它是否接受图片、视频或音频输入。

## 技能与提示词模板

- Skill 保存领域知识、制作方法和质量标准，由模型根据完整语义按需加载。
- 提示词模板是可选参考，模型可以直接编写提示词，也可以按需读取、调整或组合模板。
- Skill 不维护模板白名单；模板目录不得要求先加载 Skill，也不得因没有匹配模板限制制作范围。
- 生成节点不要求模板来源 ID；实际使用模板时可以记录 `recipeId`，但不能把它作为创建或执行的前置条件。
- 模板不授予执行权限，也不能覆盖用户要求、真实模型能力、输入槽位或工具回执。

## 画布浮层与遮挡规则

画布上的节点编辑器、输入框、菜单和工具条必须先区分“浮层被遮挡”和“浮层遮挡内容”，两者不能使用同一种定位修复。

- 节点输入面板保持产品定义的位置关系；当前生成节点输入面板固定在节点下方，不得因为与其他节点相交而自动换向或平移。
- 输入面板被其他节点遮挡属于画布内部层叠问题，应使用画布 Portal 和画布内部层级解决，不能把其他节点当作定位障碍物。
- 画布根节点必须建立隔离的层叠上下文。画布浮层可以高于画布节点，但不得用应用级超大 `z-index` 逃逸画布，必须低于剪辑工作区、模态框、媒体预览和设置窗口等应用级浮层。
- Portal 挂载点必须与浮层职责一致：节点输入面板挂到画布根节点；剪辑工作区、模态框和全屏预览挂到应用级根节点或 `document.body`。不得为了绕过裁切把画布浮层直接挂到 `document.body`。
- `z-index` 只在所属层叠上下文内比较。画布内部按“普通节点 < 选中节点 < 画布控件 < 节点输入面板”排序；应用级浮层整体高于画布层叠上下文。禁止用 `9999`、`10000` 等无边界数值代替层叠设计。
- 当前层级契约为：`.react-workflow-canvas` 使用 `isolation: isolate`，`.work-composer-anchor` 仅使用画布内部层级 `120`；剪辑工作区和应用模态框不得成为画布层叠上下文的子元素。
- 浮层必须在屏幕空间渲染，不得随画布缩放导致控件尺寸变化；画布平移、缩放和节点移动时同步更新屏幕坐标。
- 可视工作区边界只用于防止浮层离开视口：底部空间不足时可以移到节点上方，水平方向可以限制在视口内；不能因为接触其他节点、侧栏边缘或普通画布内容而改变位置。
- 锚点完全离开可用视口时隐藏其浮层，避免不可见节点留下可交互控件。
- 修改浮层前必须先复现并确认是谁遮挡谁，并检查挂载点、祖先层叠上下文、裁切属性和双方计算后的层级；不能只比较两个元素表面的 `z-index` 数字。
- 浮层测试必须同时覆盖固定位置关系、画布内覆盖、应用级窗口覆盖画布、视口边界处理和离屏隐藏；涉及剪辑窗口或模态框时，必须断言画布浮层无法逃逸其隔离层叠上下文。

## 画布缩放与清晰度规则

画布节点的图片、文字和图标必须按最终屏幕尺寸重新布局和栅格化，不能依赖对整个 React Flow viewport 使用 `transform: scale(...)` 后再放大一张合成纹理。

- React Flow 内部 viewport 的缩放值固定为 `1`，只负责屏幕空间平移、选择、拖动和连线几何。
- 项目中持久化的节点位置、节点尺寸和 viewport zoom 始终是逻辑坐标；进入 React Flow 时统一乘语义缩放，拖动、缩放框、键盘移动和右键建节点写回时统一除以语义缩放。
- 节点外框位置、外框尺寸和节点内容必须使用同一个语义缩放值；节点内容通过布局缩放按最终尺寸重绘。不得单独缩放 DOM 节点而让 SVG 连线继续使用另一套坐标。
- 适配视图、MiniMap、屏幕空间浮层和鼠标缩放锚点都必须显式接入语义缩放，不能从 React Flow 固定为 `1` 的 transform 中误读产品缩放值。
- 画布不设阈值隐藏层级（对齐参考实现）：缩放到任何倍率都不隐藏节点标题、正文、控件或端口；信息密度只随统一语义缩放自然变化。交互外壳（名称锚点里的操作按钮等非卡片内容）在缩小时保持不低于 1 倍的屏幕尺寸，放大时随内容同轨增长。
- 生成类型是编辑参数，不是节点名称。画布标题只显示真实文件名或具体语义名；“图片生成”、“视频生成”等默认类型名不得重复铺在媒体节点上方。Agent 创建节点时必须给出简短可辨识的内容标题。
- 媒体节点名称锦定在媒体卡片上沿之外，不参与节点高度、媒体尺寸或宽高比计算。语义缩放时名称和卡片必须由同一坐标系缩放，禁止用动态 `padding` 或切换节点内布局来显隐标题。
- 节点名称的视觉尺寸必须由 `.canvas-node-semantic-content` 与节点内容在同一帧、使用同一语义倍率缩放。禁止在画布根层再向名称传入独立缩放变量或叠加 `transform: scale(...)`，否则名称会比 React Flow 节点尺寸提前一帧变化并产生漂移。
- 名称标签任何倍率下都位于媒体卡片之外，不得覆盖图片或视频内容，也不得靠透明度或显隐分级弱化。名称文字本身始终是标签左边的第一个元素；`@`、类型图标和操作按钮只能放在右侧独立操作区，不得占用名称左侧空间或改变名称的水平锚点。
- 低倍率名称不得使用背景块、边框或阴影制造额外视觉块；只保留透明背景的弱化单行文字，任何倍率下都保持可见，不得隐藏。
- 节点名称必须渲染在 React Flow 节点的同级屏幕空间锚点中，不能留在使用 CSS `zoom` 的节点内容容器里。锚点左边与节点左边一致，顶部使用“节点顶部 - 28 逻辑像素 × 语义倍率”显式计算，名称带高度为 24 逻辑像素，名称为 14px 常规字重、非大写的句子大小写；标签宽度、高度、字号、间距和图标尺寸全部使用同一倍率计算，操作按钮按 `max(1, 语义倍率)` 保持最小屏幕尺寸。
- 不要把提高图片 DPR、开启 `will-change`、强制 GPU 合成或只在停止缩放后刷新图片当作整体模糊的修复；如果父级仍在缩放合成纹理，这些做法不会解决文字和图片共同发糊的问题。
- 缩放回归必须覆盖 55%、100% 和 180%：检查媒体与文字清晰度、节点与连线对齐、端口与图标不漂移，以及拖动和缩放框写回后逻辑坐标不变形。

## 生成节点输入语义规则

生成素材的媒体类型、业务位置和供应商协议必须分层保存，任何一层都不得靠连线顺序、素材数量或 UI 文案猜测。

- 节点顶层 `inputMode` 保存用户/Agent 选择的业务模式：`reference`、`firstFrame`、`firstLastFrame` 或 `videoExtension`。
- 边的 `data.inputRole` 只保存媒体类型：`textContext`、`referenceImage`、`inputVideo`、`referenceAudio`。
- 边的 `data.inputSlot` 保存业务位置：`reference`、`firstFrame`、`lastFrame`、`inputVideo`、`referenceAudio`。首帧和尾帧是槽位，不得新增为媒体角色。
- `model-catalog-v2/` 的厂商模型文件是模型输入能力的唯一来源。每个有特殊输入语义的供应商 mode 应显式声明 `inputMode` 和可选 `inputSlots`；同一供应商协议支持多种画布语义时使用 `inputVariants` 复用协议，并为每个变体覆盖槽位、输入约束和请求角色。UI、Agent 和请求编译器只能消费目录结果，不能各自维护供应商判断。
- 节点模式选择器只展示当前模型真实支持的模式。切换模型或模式时必须同步校正输入边；保留文本上下文，重排仍合法的媒体槽位，移除超出新模式能力的媒体边。
- 首尾帧必须分别写入 `firstFrame` 与 `lastFrame`，不得使用数组第一个/第二个作为隐式协议。普通参考图统一写 `reference`，视频与参考音频分别写 `inputVideo`、`referenceAudio`。
- Agent 的模型目录、画布快照、`create_gen_node`、`update_gen_config`、`inputLinks` 和 `connect_nodes` 必须能读写同一套 `inputMode`/`slot` 契约；用户操作和 Agent 操作不得生成不同的数据结构。
- 运行前根据节点 `inputMode` 选择目录中的供应商 mode，再按 `inputSlot` 稳定排序并编译请求。当前模型未公开某模式时必须明确报错，不得降级成另一个语义相近但不同的模式。
- 新供应商接入至少测试：目录模式可见性、节点切换、槽位持久化、Agent 读写、数量/类型校验、最终请求 mode 与字段映射。

## 生成节点参数面板规则

- 生成节点底栏只保留模型入口、当前参数摘要和固定在右侧的发送按钮，不得把模型的全部参数逐个横向铺开。
- 比例、分辨率、时长、声音、水印和生成方式等参数统一收纳到分组设置面板；选项较少时使用分段按钮或选项块，比例应提供可辨认的方向图形。
- 参数摘要允许截断，但发送按钮不得被挤出节点编辑器。编辑器宽度应根据画布可视区域限制并校正水平位置，不能越过画布边界。
- 只有一个输入模式时不显示无意义的模式下拉；有两个及以上模式时才在设置面板展示模式切换。
- 新模型增加大量参数时，应由设置面板内部滚动承载，不能恢复底栏横向堆叠，也不能让弹层被参数容器裁切。
- `presentation.control: 'select'` 只给选项多到铺不成选项块的参数（如 41 个语种）。原生 select 的上下双箭头是操作系统控件，必须抹掉原生外观并复用音色选择器同一枚 chevron；四到六档的参数（采样率、比特率）一律铺成选项块，面板里不得残留原生下拉外观。
- 倍率型滑杆（语速 0.5–2、音量 0.1–10）用 `presentation.scale: 'log'` 声明对数轨道，否则默认值 1 会停在线性轨道的 9% 处看起来像空轨。轨道域与真实值的换算只在 `utils/modelPresentation.ts` 的 `sliderTrackDomain`/`sliderTrackPosition`/`sliderValueFromTrack` 一处，写回配置的仍是按 `presentation.step` 量化后的真实值，滑杆组件不得自己算。
- 底栏摘要里裸数字读不出是哪项参数：滑杆类参数必须带参数名（"语速 1"而不是"1"），选项块的值本身可读，不加标签。

## 生成节点模块边界

- `app/canvas/generationNodeState.ts` 是节点派生值的唯一来源：输出选择、活动媒体、模型目录、参数、输入模式和文本正文都在这里算一次，媒体体、输入面板和参数面板只消费同一份结果，不得各自重算。
- `GenerationNode.tsx` 只做组装和节点名称标签；`GenerationNodePreview.tsx` 拥有媒体与播放状态；`GenerationNodeImageOverlays.tsx` 拥有裁剪和标注；`GenerationNodeComposer.tsx` 拥有输入面板交互；`GenerationSettingsPanel.tsx` 只按目录 presentation 渲染控件。
- 界面契约测试读取这组模块的拼接源码（`tests/helpers/generationNodeSource.mjs`），拆分文件时不要改成只读单个文件，也不要把同一个契约复制到各文件的测试里。

## 画布资源下载规则

- 下载一个本地资源时必须直接导出原始文件，保留文件名和扩展名，不得为单文件生成 ZIP 资源包。
- 只有实际收集到两个及以上文件时才使用资源包；判断依据是去重后的本地文件数量，不是选中节点数量。

## 画布节点操作入口规则

- `加入对话` 是节点操作，不是节点名称或节点内容的一部分。不得在节点标题、名称标签、资源头部或 3D 导演台头部常驻渲染 `@` 按钮。
- 引用节点的入口统一放在 React Flow `NodeToolbar` 选中工具栏中，仅当节点被选中时显示，并使用“加入对话”语义文案而不是孤立 `@`。工具栏属于画布内部屏幕空间操作层，不随节点语义缩放改变控件尺寸。
- 选中媒体节点时，工具栏应根据真实本地输出展示“存为资产”；视频节点还可展示“音频分离”。两者必须调用真实素材库和 FFmpeg 能力，不得只渲染无行为按钮。音频分离成功后创建普通音频节点并登记项目素材；无音轨时明确报错。

## 样式分层与色阶

- 全局样式按界面区域分文件（`renderer/styles/<area>.css`），`renderer/src/main.tsx` 的导入顺序就是层叠顺序：调整先后等于改优先级。`tokens.css` 必须最先导入，新增区域样式表要同时在这里登记——写了不导入等于写死样式。
- `renderer/styles.css` 只保留 reset、滚动条与焦点环这一层基础语言，不得出现组件选择器，也不得定义自定义属性。组件样式属于区域文件或组件自己的 `*.module.css`。
- 颜色只从 `renderer/styles/tokens.css` 的具名令牌出发。组件规则里不得再手写 hex、`rgb()/rgba()`、`hsl()`：同一角色的灰底、遮罩、可拖拽细条、半透明浮层和强调色底/描边各有唯一档位，界面层在 `.dark` 里必须换向，否则暗色主题会出现脏白底和看不见描边。
- 具体色值只允许写在自定义属性声明上（`tokens.css` 与厂商主题层）。压在图片/视频上的 `--overlay-*` 不做深色镜像：它属于素材不属于界面。
- `renderer/src/vendor/` 是上游第三方样式，保持原样、不参与色阶规则，由 3D 导演台宿主适配层隔离。
- 以上边界由 `scripts/verify-styles.mjs`（`npm run check:styles`）机器检查，它同时拒绝没有真实定义的 `var()` 引用。

## Vendored 第三方应用

`renderer/src/vendor/storyai-3d-director-desk/` 保留上游源码，作为一个独立的 iframe 应用运行（入口 `renderer/director-desk.html`）。它与产品之间唯一的通道是那份私有 postMessage 协议，产品侧唯一的拥有者是 `renderer/src/app/adapters/directorDeskBridge.ts`。

- 产品代码不得 import `vendor/` 下的任何模块：源码级依赖会让上游更新变成一次产品内重构，也会让上游的 zustand store 变成界面可达的状态源。
- 协议消息名（`storyai:director-desk-*`）和 iframe 入口地址只允许写在宿主适配层里。画布组件消费类型化回调（`onReady`、`onProjectChanged`、`onCaptures`……），不得自己比较字符串。
- 来源校验属于协议：宿主只接受同源且确实来自当前导演台窗口的消息，其他 iframe 或扩展发来的同名消息不算回执。
- 导演台的输入（会话、全景图）与回执（工程变更、截图、连线移除）都在适配层一次构造和整形完毕；上游协议变更时只改这一个文件。
- 以上边界由 `scripts/verify-module-discipline.mjs`（`npm run check:layers`）检查：分层表里没有通往 `vendor` 的许可，产品文件出现契约字符串即视为违规。

## 实现与重构要求

- 不保留旧逻辑兼容层；确定新契约后删除旧字段、旧分支和旧测试。
- 目录只按职责存在，不再设 `composables/`、`types/` 这类按语法形态分装的杂物层：应用生命周期逻辑属于 `app/`（关闭确认守卫就在 `app/windowCloseGuard.ts`），类型与常量跟着使用它的模块走，没有消费者的导出就删掉。环境声明集中在 `renderer/src/env.d.ts`。
- `scripts/verify-module-discipline.mjs` 的分层表就是目录清单：未登记的顶层目录和源根目录里的游离源文件都会被拒绝，新增目录必须在这里说明它拥有什么职责。
- 内部 import 说明符必须解析到真实源文件。JS→TS 迁移不得留下 `./x.js` 后缀残留：TypeScript 能把它解析到 `x.ts`，Vite 与 Tauri 运行时却直接 404；`scripts/verify-module-discipline.mjs` 会拒绝无法解析的说明符。
- 互相引用（同一强连通分量）的模块只能在函数调用时读取对方的导出绑定，不得在模块作用域快照一份（`const store = rawStore as X`）：求值顺序只取决于入口，浏览器、SSR 与生产构建各不相同，读早了就是 `Cannot access 'x' before initialization` 白屏，而各从不同入口进来的单测看不见它。该边界由 `scripts/verify-module-discipline.mjs`（`npm run check:layers`）检查；需要类型视图时在回调参数上显式标注，或给被依赖模块的导出补类型。`tests/app-boot.test.mjs` 只负责入口模块图能求值。
- `renderer/src` 只允许 `.ts/.tsx`，`tsconfig.json` 保持 `allowJs: false`：`include` 只覆盖有类型模块，混进来的 `.js` 能构建、能运行，却永远不会被 `tsc` 检查过一眼，等于重开一个无类型死角。
- 测试的共享装配只有一份：读产品源码走 `tests/helpers/sourceContract.mjs`（仓库根相对路径 + 缓存），在渲染进程源码上跑真实模块图走 `tests/helpers/rendererSsr.mjs`。测试文件自己拼 `readFileSync(new URL(...))` 或起 `createServer()` 会被 `scripts/verify-test-architecture.mjs`（`npm run check:tests`）拒绝。用例之间的工具注册表清空由 `beforeEach`/`afterEach` 钩子负责，断言抛异常时钩子照样执行；权限与结论回合一类契约测试必须消费循环自己派生的事件出口，不得在测试里替它接线。
- 注释解释设计边界和原因，不复述代码表面行为。
- 减少无意义的小函数和嵌套三元表达式，优先使用清晰的顺序逻辑。
- 测试应验证权限、安全、事实和持久化边界，不要通过测试固化模型本应负责的启发式判断。
- 修改 Agent 行为时，先检查本文件，再检查相关 Prompt、Skill 和 Contract 是否与代码职责一致。
