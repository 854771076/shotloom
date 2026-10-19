import test from 'node:test';
import assert from 'node:assert/strict';
import { readSource, sourceExists } from './helpers/sourceContract.mjs';

const read = (path) => readSource(path);
const dir = '../renderer/src/app/agent-chat/';

const panel = read(`${dir}AgentChatPanel.tsx`);
const transcript = read(`${dir}Transcript.tsx`);
const trace = read(`${dir}ToolTrace.tsx`);
const plan = read(`${dir}PlanCard.tsx`);
const composer = read(`${dir}Composer.tsx`);
const history = read(`${dir}HistoryDrawer.tsx`);
const artifacts = read(`${dir}ArtifactList.tsx`);
const referenceCard = read(`${dir}ReferenceCard.tsx`);
const mediaThumb = read(`${dir}MediaThumb.tsx`);
const presentation = read(`${dir}messagePresentation.ts`);
const session = read('../renderer/src/app/adapters/agentSession.ts');
const presenter = read('../renderer/src/app/agent-session/runtimePresenter.ts');
const canvasTools = read('../renderer/src/agent/tools/canvasTools.ts');
const toolRegistry = read('../renderer/src/agent/core/toolRegistry.ts');
const traceStyles = read(`${dir}ToolTrace.module.css`);
const planStyles = read(`${dir}PlanCard.module.css`);
const transcriptStyles = read(`${dir}Transcript.module.css`);
const artifactStyles = read(`${dir}ArtifactList.module.css`);
const tokens = read('../renderer/styles/agent-theme.css');
const modules = ['AgentChatPanel', 'Transcript', 'ToolTrace', 'PlanCard', 'Composer', 'HistoryDrawer', 'ArtifactList', 'ClarificationCard', 'ReferenceCard', 'MediaThumb']
  .map((name) => read(`${dir}${name}.module.css`))
  .join('\n');

test('助手面板不再依赖 antd，样式只来自 CSS Modules 与 --slk-* 令牌', () => {
  for (const source of [panel, transcript, trace, plan, composer, history, artifacts, referenceCard, mediaThumb]) {
    assert.doesNotMatch(source, /@ant-design|from "antd"/);
    assert.match(source, /from "\.\/\w+\.module\.css"/);
  }
  assert.doesNotMatch(`${panel}${composer}`, /ConfigProvider/);
  assert.ok(!sourceExists('renderer/src/app/agent-session/AgentPanel.tsx'));
  assert.doesNotMatch(modules, /#[0-9a-f]{3}\b/i);
  assert.match(modules, /var\(--slk-/);
});

// 暗色模式整条链路都不存在：令牌只有浅色一套值，面板没有主题属性和切换入口。
test('助手面板只有浅色，不提供暗色模式', () => {
  assert.ok(!sourceExists(`${dir}useAgentTheme.ts`));
  assert.doesNotMatch(`${tokens}${modules}${panel}`, /data-slk-theme/);
  assert.match(tokens, /--slk-bg-base: var\(--surface\)/);
  assert.doesNotMatch(panel, /theme/i);
});

// 面板曾经自带第五套灰阶（--slk-static-n-*），和画布、侧栏的墨阶在同一窗口里并存。
test('助手面板的色值全部来自产品 token，没有第二套色阶', () => {
  assert.doesNotMatch(tokens, /--slk-static|#(?:[0-9a-f]{3}|[0-9a-f]{6})\b/i);
  assert.doesNotMatch(`${tokens}${modules}`, /--slk-static|--slk-border-l4\b/);
  assert.match(tokens, /--slk-label-primary: var\(--text\)/);
  assert.match(tokens, /--slk-label-secondary: var\(--muted\)/);
  assert.match(tokens, /--slk-border-l1: var\(--line-soft\)/);
});

// 面板曾经自带 --slk-font-delta 伪流式刻度（delta 永远是 0），产出 10.5/12.5/17/19 这些阶梯外字号。
test('助手面板字号只走 tokens.css 阶梯，字体栈只有一个入口', () => {
  assert.doesNotMatch(
    `${tokens}${modules}`,
    /--slk-(font-delta|font-secondary|code-delta|content-font-size|code-font-size|font-family|font-code)/,
  );
  const literalSize = /font(?:-size)?:\s*(?:[1-9]00\s+)?(?:calc\(|\d+(?:\.\d+)?(?:px|em))/;
  assert.doesNotMatch(modules, literalSize);
  assert.match(modules, /var\(--font-ui\)/);
  assert.match(modules, /var\(--font-mono\)/);
});

test('运行轨迹默认一行摘要，待确认或出错时才自动展开', () => {
  assert.match(trace, /const \[open, setOpen\] = useState\(false\)/);
  assert.match(trace, /setOpen\(hasPending \|\| failed\)/);
  assert.match(trace, /if \(\(!tools\.length && !knownSubagents\.length\) \|\| waitingForAnswer\) return null/);
  assert.match(trace, /aria-expanded=\{open\}/);
  assert.match(trace, /\{open && \(\s*<ol className=\{styles\.steps\}/);
  assert.match(trace, /等待确认/);
  // 折叠头部说的是"这一组做了什么"，由类别折叠而来；不再重复一次"执行过程有错误"，
  // 也不再摆一个 settled/total 计数——失败由消息级失败块承担，数量不是用户要的信息。
  assert.match(trace, /const headline = settled \? processTitle\(summary\) : liveTitle\(summary\)/);
  assert.doesNotMatch(trace, /执行过程有错误|styles\.headCount/);
  assert.doesNotMatch(trace, /运行记录/);
  // 只有真实交互号才渲染确认区，不能凭空出现可点的批准按钮。
  assert.match(trace, /tool\.pending && tool\.interactionId/);
});

// 工具名来自注册表、结果来自回执，界面不再各自维护中文名字表，也不会只剩"已运行"。
test('工具步骤显示注册表标题与真实产出', () => {
  assert.match(trace, /tool\.title \|\| agentToolTitle\(String\(tool\.name \|\| ""\)\)/);
  assert.doesNotMatch(presenter, /const labels/);
  assert.match(presenter, /output: event\.isError \|\| event\.pending \? '' :/);
  assert.match(presenter, /display\?\.summary \|\| receiptOutcome\(receipt\)/);
  assert.match(canvasTools, /summarizeResult: snapshotDisplay/);
  assert.match(canvasTools, /nodeSummaryLabel\(input\.nodeId\)\} @ /);
  assert.doesNotMatch(canvasTools, /node\(s\)/);
  assert.match(trace, /\{expanded && \(/);
  // 参数与结果只在展开时挂载全文；耗时同样只在展开体里，摘要行尾不留一列数字。
  assert.match(trace, /\{\(!!tool\.output \|\| !!previews\.length\) && \(/);
  assert.match(trace, /JSON\.stringify\(args, null, 2\)/);
  assert.match(trace, /formatDuration\(tool\.startedAt, tool\.endedAt\)/);
  assert.doesNotMatch(trace, /styles\.stepDuration/);
  assert.match(traceStyles, /\.stepLine \{[^}]*grid-template-columns: var\(--icon-xs\) minmax\(0, 1fr\) var\(--icon-xs\)/);
  // 缩略图必须复用项目的图片预览缓存，直接引用 asset 协议在画布里从来不是图片路径。
  assert.match(trace, /useMediaPreviewCache\(\{ path, kind: "image", maxSize: 320 \}\)/);
  assert.doesNotMatch(trace, /convertFileSrc/);
  assert.match(traceStyles, /\.preview \{[^}]*object-fit:\s*cover/);
});

// 图标由工具自己声明，展示层只保留运行时合成行的类别图标，不再把所有步骤画成同一个扳手。
test('工具步骤图标取自注册表声明而不写死在界面', () => {
  assert.match(trace, /kindIcon\[String\(tool\.kind \|\| ""\)\] \|\| agentToolIcon\(String\(tool\.name \|\| ""\)\)/);
  // 头部图标来自活动类别，而不是"最后一步用的工具"。
  assert.match(trace, /name=\{headIcon\(summary\)\} className=\{styles\.headIcon\}/);
  assert.doesNotMatch(trace, /statusIcon|"wrench"/);
  assert.match(toolRegistry, /return definition\.icon \|\| effectIcon\[definition\.effect\] \|\| 'wrench'/);
  assert.match(toolRegistry, /return definition\.activity \|\| effectActivity\[definition\.effect\] \|\| 'tools'/);
});

// 完成的一步不再重复一个"已运行"：图标 + 标题 + 摘要已经说完了。
// 只有需要用户行动的三种状态才留状态词，失败还要把结果首行顶到摘要位。
test('步骤行只在需要行动的状态下显示状态词', () => {
  assert.doesNotMatch(trace, /success: '已运行'|success: "已运行"/);
  assert.match(trace, /const stateText = statusLabel\[status\] \|\| ""/);
  assert.match(trace, /\{!!stateText && <span className=\{styles\.stepState\}/);
  assert.match(trace, /status === "error" \? firstLine\(tool\.output\)/);
  assert.match(traceStyles, /\.step\[data-status="error"\] \.stepSummary \{[^}]*--slk-state-error/);
});

test('待确认调用允许在批准前修改参数，非法 JSON 不得提交', () => {
  assert.match(trace, /JSON\.parse\(text\)/);
  assert.match(trace, /!Array\.isArray\(parsed\)/);
  assert.match(trace, /disabled=\{Boolean\(parseError\)\}/);
  assert.match(trace, /changed \? \{ modifiedArgs \} : \{\}/);
  assert.match(trace, /恢复原参数/);
});

test('运行中composer不锁死输入，停止是独立控件，排队消息只显示等待态', () => {
  assert.match(composer, /className=\{styles\.stop\}/);
  assert.match(composer, /onClick=\{controller\.cancel\}/);
  assert.match(composer, /onClick=\{submit\}/);
  assert.doesNotMatch(composer, /readOnly=\{busy\}|busy \? controller\.cancel\(\) : submit\(\)/);
  assert.doesNotMatch(modules, /\[data-stop\]/);
  assert.match(trace, /aria-label="停止 Agent"/);
  assert.match(transcript, /busy &&[\s\S]*?!messages\.some/);
  assert.match(transcript, /busy && message\.deliveryStage === "sent"/);
  assert.doesNotMatch(composer, /加入队列|queue|排队/);
});

test('相同 Runtime 失败合并成紧凑诊断卡，重试只在非运行态出现', () => {
  assert.match(panel, /compactRepeatedFailures\(messages\)/);
  assert.doesNotMatch(panel, /useMemo\(\(\) => compactRepeatedFailures\(messages\), \[messages\]\)/,
    '消息数组就地更新时，不能用数组引用缓存展示列表');
  assert.match(presentation, /repeatedFailureCount/);
  assert.match(presentation, /markdownByMessage = new WeakMap/);
  assert.match(transcript, /repeatsFollowingFailure\(message, next\)/);
  assert.match(transcript, /message\.retryable && !busy/);
  assert.match(transcript, /controller\.retry\(message\.id\)/);
  assert.match(transcript, /<summary>详情<\/summary>/);
});

test('完成态沿用流式正文而不是用最终响应整段覆盖', () => {
  assert.match(session, /flush\(\);\s*finalizeMessage/);
  assert.match(session, /content:\s*presentation\.streamed \|\| result\?\.reply/);
  assert.doesNotMatch(session, /content:\s*result\?\.reply \|\| presentation\.streamed/);
});

test('制作计划只在 plan 变化时重置展开，并按阶段定位真实节点', () => {
  assert.match(plan, /plan\.schemaVersion !== 2 \|\| !stages\.length\) return null/);
  assert.match(plan, /setExpandedStage\(null\);\s*\}, \[plan\?\.id\]\)/);
  assert.match(plan, /const stageNodeIds = \(stage\.runtimeRefs \|\| \[\]\)\.flatMap/);
  assert.match(plan, /controller\.focusNodes\(stageNodeIds\)/);
  assert.doesNotMatch(plan, /controller\.focusNodes\(\s*stages/);
  assert.doesNotMatch(plan, /plan_review|result_review|reviewProductionStage/);
  // 计划卡是一张待办披露卡：头部只有图标 + 标题 + 状态计数 + 箭头，进度不画成条形图，
  // 也不在标题上方摆一个模式眉标；展开体是定高滚动的扁平行列表。
  assert.doesNotMatch(planStyles, /\.bar|barFill/);
  assert.doesNotMatch(plan, /styles\.headCopy|executionMode === "execute" \? /);
  assert.match(planStyles, /\.stages \{[^}]*max-height:\s*180px/);
  assert.match(planStyles, /\.stages \{[^}]*overflow-y:\s*auto/);
  assert.doesNotMatch(planStyles, /\.workItems > li \{[^}]*background:/);
});

test('@ 引用的节点卡片只发送契约字段，媒体预览与附件不进请求', () => {
  assert.match(panel, /resolveNodeChatImageAttachment\(node\)/);
  assert.match(composer, /addNodeMentionById/);
  assert.match(composer, /useImperativeHandle\(props\.forwardedRef/);
  assert.match(composer, /addMention\(found\)/);
  assert.match(composer, /attachNodeImage\(node\)/);
  assert.match(composer, /nodeMentions: mentions\.map\(\(\{ imageAttachment: _drop, node: _node, \.\.\.item \}\) => \(\{ \.\.\.item \}\)\)/);
  // 引用卡描述只随消息持久化供界面回看，不得进模型请求。
  assert.match(composer, /references: references\.map\(\(item\) => item\.reference\)/);
  assert.doesNotMatch(session, /references: payload\.references/);
});

test('引用与发送落在面板当前显示的会话上，不二次解析项目级 active 指针', () => {
  assert.match(composer, /conversationId: activeConversationId/);
  assert.match(history, /controller\.selectConversation\(conversation\.id\)/);
  assert.match(panel, /controller\.clear\(activeConversationId\)/);
  assert.match(history, /window\.confirm\(/);
});

test('未配置文本模型时输入区给出可执行说明而不是静默失效', () => {
  assert.match(composer, /const disabled = !textModels\.length/);
  assert.match(composer, /还未配置文本模型/);
  assert.match(composer, /disabled=\{disabled\}/);
});

test('流式跟随底部但不使用平滑动画，离开底部后改为未读计数', () => {
  assert.match(panel, /followsLatest\.current\) \{\s*requestAnimationFrame\(\(\) => scrollToLatest\("smooth"\)\)/);
  assert.match(panel, /scrollToLatest\("auto"\)/);
  assert.match(panel, /< 48/);
  assert.match(panel, /setUnread\(\(value\) => value \+ added\)/);
});

// 进行中的反馈只能有一个：排队时底部提示补位，占位消息出现后由思考中/正文/工具轨迹承担。
test('发送后不叠加投递文案，也不与底部处理提示同时出现', () => {
  assert.match(transcript, /const running = busy && !messages\.some\(\(message\) => message\.role === "assistant" && message\.typing\)/);
  assert.doesNotMatch(transcript, /已发送，等待 Agent 接收/);
  assert.doesNotMatch(modules, /\.delivery \{/);
  // 投递失败仍然是必须可见的事实。
  assert.match(transcript, /message\.deliveryStage === "failed" && message\.deliveryError/);
});

// 进行中的反馈必须真的在动：依次点亮的点 + 文字扫光，只在静止偏好下退回静态。
test('思考中与排队提示带可见动画', () => {
  assert.match(transcript, /className=\{styles\.dots\} aria-hidden="true"/);
  assert.match(transcriptStyles, /\.dots > i \{[^}]*animation:\s*dot-pulse 1\.1s var\(--slk-ease\) infinite/);
  assert.match(transcriptStyles, /\.dots > i:nth-child\(3\) \{[^}]*animation-delay:\s*0\.3s/);
  assert.match(transcriptStyles, /\.shimmer \{[^}]*animation:\s*sweep 1\.5s linear infinite/);
  assert.match(transcriptStyles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.dots > i \{[^}]*animation: none/);
});

// 产物卡与引用卡共用同一张缩略图：无边框、无文字，名称留在提示与无障碍标签里。
test('产物卡复用共享媒体缩略图，定位入口悬停才出现', () => {
  assert.doesNotMatch(artifacts, /styles\.info|statusLabel|kindLabel|useMediaPreviewCache|openMediaViewer/);
  assert.match(artifacts, /<MediaThumb\n\s+kind=\{artifact\.kind\}\n\s+path=\{artifact\.path\}/);
  assert.match(artifacts, /aria-label=\{`在画布中定位：\$\{artifact\.title\}`\}/);
  assert.doesNotMatch(modules, /\.info \{/);
  // 无边框、无底色：卡片不再给素材套一层壳。
  assert.doesNotMatch(artifactStyles, /\.card \{[^}]*(box-shadow|background:|--slk-stroke-color)/);
  assert.match(artifactStyles, /\.locate \{[^}]*opacity:\s*0/);
  assert.match(artifactStyles, /\.card:hover \.locate,[\s\S]*?\.locate:focus-visible \{\s*opacity:\s*1/);
  // 产物不再自带一条"本轮产物"标题：两列铺开，超过四个先收起，数量只在折叠入口说一次。
  assert.match(artifacts, /aria-label="本轮产物"/);
  assert.doesNotMatch(artifacts, /styles\.head|name="layers"/);
  assert.match(artifacts, /const COLLAPSED_COUNT = 4/);
  assert.match(artifacts, /expanded \? "收起" : `全部 \$\{artifacts\.length\} 个产物`/);
  assert.match(artifactStyles, /\.grid \{[^}]*repeat\(2, minmax\(0, 1fr\)\)/);
});

// 应用写入的事实不是助手正文：一行提示不能带轨迹、计划与产物卡，也不自成气泡。
test('轮次边界与状态提示是提示行而不是助手回复', () => {
  assert.match(transcript, /if \(message\.notice\) \{/);
  assert.match(transcript, /data-notice=\{message\.notice\}/);
  assert.match(session, /notice: "divider"/);
  assert.match(session, /notice: "status"/);
  assert.doesNotMatch(session, /title: "目标"/);
  // 分隔线只在 divider 上出现，状态行不带线。
  assert.match(transcriptStyles, /\.notice\[data-notice="divider"\] > i \{/);
});

// 复制回复不是这一屏的职责，正文选中即可复制，不再常驻一个操作按钮。
test('助手消息不带复制按钮', () => {
  assert.doesNotMatch(transcript, /MessageActions|navigator\.clipboard|styles\.action|IconSymbol name="copy"/);
  assert.doesNotMatch(transcriptStyles, /\.actions \{|\.action \{/);
});
