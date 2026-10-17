# Shotloom UI 设计规范（design.md）

> 基准：`MiniMax-Design-4.0.0-analysis`（本地解包的 Electron 应用，V3 工作台为权威版本）。
> 参考项目 CSS：`app/out/renderer/v3/assets/index-D20guzI6.css`（token）、`CanvasPage-BmZNABX4.css`（画布）、`CanvasPage-MuABU4gC.js`（节点尺寸/缩放逻辑）。
> Shotloom 现状来源：`renderer/styles/*.css`、`renderer/src/app/**`、`renderer/src/domain/graph/CanvasNodeDimensions.ts`。
> 所有数值均逐条取自双方真实文件，已抽查核验（46px 工具条、0.1–4 缩放、1/1.5px 反转描边、`#6D6CFF` 品牌色等）。

---

## 0. 总体结论

Shotloom 的**浅色基础色板已经和参考项目高度一致**（`--bg #fafafa`、`--surface #fff`、`--line rgba(0,0,0,.08)`、`--muted rgba(0,0,0,.5)`、`--faint rgba(0,0,0,.32)` 完全同值），说明底层审美方向相同。差距集中在六个方面：

1. **没有暗色主题**——参考项目每个 token 都有 `.dark` 对应值。
2. **字号碎片化**——Shotloom 全仓出现 8–28px 十几种字号且无 token 化比例；参考项目用 `--text-caption-10 … --text-display-24` 的成对"字号+行高"语义标尺。
3. **字重分裂**——legacy `styles.css` 用 800/850/900，settings 与 agent 面板用 400–650；参考项目只有 300/400/500/600 四档，UI 正文一律 400。
4. **强调色三套并存**——黑色品牌 + legacy 蓝（#2f6f93/#59616a/#65778c）+ agent 冷蓝 rgb(52,102,214)；参考项目是"黑白为主 + 单一 `--brand-accent`（#6D6CFF 紫）只用于可点击/活跃"。
5. **圆角/间距无刻度**——Shotloom 出现 2–28px 二十种圆角、没有 spacing scale；参考项目圆角全部从 `--radius: 12px` 按比例派生，间距严格 4px 倍数。
6. **画布缩放策略不同**——Shotloom 用低倍率阈值隐藏内容（0.8/0.35/0.20 三档）；参考项目**从不隐藏**，而是对交互外壳做反缩放（`clamp(1, 1/zoom, 2.5)`）并把描边除以 zoom，缩放范围 0.1–4×。

---

## 1. 设计 Token（色彩 / 圆角 / 阴影 / 间距）

### 1.1 色彩

参考项目 `:root`（light）→ `.dark`，成对定义，全部语义化：

| 语义 | MiniMax light | MiniMax dark | Shotloom 现状 | 判定 |
| --- | --- | --- | --- | --- |
| 页面背景 `--background` | `#fafafa` | `#181818` | `--bg #fafafa` | 值同，缺 dark |
| 卡片 `--card` | `#ffffff` | `#161616` | `--surface #fff` | 值同，缺 dark |
| 浮层 `--elevated-surface` | `#ffffff` | `#1f1f1f` | 无独立 token（各浮层自行写 `rgba(255,255,255,.88/.96)`） | **缺** |
| 次级底 `--secondary/--accent` | `#f5f5f5` | `#1a1a1a` | `--surface-2 #f5f5f5` | 值同 |
| 弱底 `--muted` | `#fafafa` | `#1a1a1a` | 无 | 缺 |
| 主文字 `--foreground` | `#000000` | `#e0e0e0` | `--text #000` | 值同 |
| 次文字 `--muted-foreground` | `rgba(0,0,0,.5)` | `rgba(255,255,255,.6)` | `--muted .5` | 值同 |
| 三级文字 `--text-tertiary` | `rgba(0,0,0,.32)` | `rgba(255,255,255,.42)` | `--faint .32` | 值同 |
| 禁用文字 `--fg-disabled` | `color-mix(fg 35%)` | `30%` | 散落硬编码 | **缺** |
| 边框 `--border` | `rgba(0,0,0,.08)` | `rgba(255,255,255,.1)` | `--line .08` | 值同 |
| 弱边框 `--border-soft` | `rgba(0,0,0,.05)` | `.05` | `--line-soft .05` | 值同 |
| 强边框 `--border-strong` | `rgba(0,0,0,.12)` | `.14` | 无 | 缺 |
| 实色边框 `--border-solid` | `#e6e6e6` | `#454545` | 节点用 `#e3e3e3` | 近似 |
| 品牌强调 `--brand-accent` | `#6D6CFF` | `#8B8AFF` | 无对应（黑色品牌 + 三套蓝混用） | **体系差异，见 §2.4** |
| hover 浮层 `--popup-item-hover` | `rgba(0,0,0,.03)` | `rgba(255,255,255,.04)` | agent 有 hover-wash .05 / strong .09 | 参考更轻 |
| active `--popup-item-active` | `rgba(0,0,0,.06)` | `.06` | agent active .12 | 偏重 |
| 画布控件 hover | `#0000000d`（~5%） | `#ffffff1a` | 各异 | 需统一 |
| ring/focus `--ring` | `rgba(0,0,0,.3)` | `rgba(255,255,255,.3)` | 4 套互相打架的 focus 方案 | **必改，见 §6** |
| 画布框选 | `--canvas-selection-bg #0000000f`，边框 1.5px | `#ffffff0f` | 橙色 `rgba(237,106,53,.46)` 单色一次性值 | **不一致来源** |
| 模态遮罩 | `--modal-mask-bg rgba(0,0,0,.62)`、媒体 `.85`、dim `.5`、blur 16px | 同 | `rgba(15,23,42,.28)` 等各自写 | **缺** |

参考的 alpha 哲学：**中性文字与浮层全部用 rgba 黑/白百分比**（.03/.05/.06/.08/.12/.32/.5），暗色镜像为白 alpha；只有语义色用 oklch。Shotloom 的 `--type-primary .82` 系列与参考的整数 alpha（.5/.32）不成体系。

**目标规范**
- 建立与参考同名同值的 token 全集，并补 `.dark` 分支（Shotloom 目前 tokens.css 仅 32 行、light-only）。
- 弹层浮面统一 `--elevated-surface`（light `#fff` / dark `#1f1f1f`）+ `--elevated-border-color`（.08/.10），废弃各处 `rgba(255,255,255,.88/.96)` 半透明自造。
- 品牌可点击色收敛为一个 `--brand-accent`；黑色 `#000/#171717` 只用于主按钮与选中态，legacy 蓝全部清除。

### 1.2 圆角

参考只有一个根 `--radius: 12px`，其余全部派生：

```
--radius-sm: calc(var(--radius)*0.6)  ≈ 7.2px
--radius-md: calc(var(--radius)*0.8)  ≈ 9.6px
--radius-lg: var(--radius)             = 12px
--radius-xl: calc(var(--radius)*1.4)   ≈ 16.8px
画布媒体节点: --canvas-media-node-radius 10px / inner 8px
菜单/面板: var(--radius)=12；对话框 16.8/16
```

Shotloom：tokens 只给了 10/14/16 三档，实际磁盘上出现 **2,3,5,6,7,8,9,10,11,12,13,14,15,16,17,18,20,22,28 约 20 种圆角**（agent 面板自成一套 4/8/12/16/20/28）。
**规范**：全局收敛到 sm/md/lg(12)/xl + 画布 10/8 两层；节点 10px（与参考一致，Shotloom 现状已是 10）；浮层菜单 12px；大对话框 16–17px；禁止再出现 13/15/18/22 这类一次性值。

### 1.3 阴影

参考把阴影按用途 token 化，且**极轻**（黑 8%–12% 左右）：

```
--canvas-shadow-panel:    0 2px 5px rgba(0,0,0,.078)
--canvas-shadow-dropdown: 0 4px 10px rgba(0,0,0,.12), 0 2px 4px rgba(0,0,0,.06)
--canvas-shadow-menu:     0 8px 32px rgba(0,0,0,.08), 0 2px 8px rgba(0,0,0,.04)
--canvas-prompt-panel-shadow: 0 4px 20px rgba(0,0,0,.06)
--drop-shadow-sm:         0 1px 2px rgba(0,0,0,.15)
暗色对应值 alpha 更高一档。
```

Shotloom：`--shadow 0 12px 30px -24px` 一枚走天下 + 各浮层自写（`0 10px 28px rgba(15,23,42,.075)`、`0 8px 24px`、`0 28px 80px` 等）。agent 的"0.5px 描边入 box-shadow" elevation 模式与参考的 `inset box-shadow 描边` 思路一致，可保留并推广。
**规范**：按 panel / dropdown / menu / prompt 四档建立阴影 token，全部使用参考数值；描边一律走 inset box-shadow 或 border，不再叠大扩散阴影。

### 1.4 间距

参考：Tailwind `--spacing: 4px`，一切 gap/padding 为 4 的倍数（画布内例外见各组件规范）。
Shotloom：**没有 spacing scale**，出现 2/3/6/7/8/9/10/12/14/16/18/20/22/24/25/26/28/46 等自由值。
**规范**：确立 4px 基准栅格；组件内部允许 2px 级微调（如工具条 padding 2、gap 2 本身就是参考的做法），但页面级布局 padding 必须落在 4 倍数上。

---

## 2. 字体系统

### 2.1 字体栈

| 用途 | MiniMax | Shotloom |
| --- | --- | --- |
| UI sans | `ui-sans-serif, system-ui` + 实际生效栈含 `"PingFang SC","Microsoft YaHei"` | `-apple-system…"PingFang SC","Noto Sans SC"` ✅ 基本等价 |
| mono | `ui-monospace, SFMono-Regular, Menlo…` | `--slk-font-code`（SF Mono/JetBrains…，且 code 里混入 PingFang） |
| 正文 smoothing | `-webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale`（body 全局） | 未见全局声明 **→ 补** |
| 中文 serif | 无（参考不做衬线正文） | 文本编辑器 Songti/Noto Serif 1.8 行高——属 Shotloom 自有产品决策，保留但字号并入统一标尺 |

### 2.2 字号标尺（核心差距）

参考项目每个字号都**成对绑定行高**并语义命名（`index-D20guzI6.css`），使用频率与角色明确：

| token | 字号/行高 | 角色（参考实测用法） | Shotloom 现状对应 |
| --- | --- | --- | --- |
| `--text-caption-10` | 10 / 14 | 归因、连线标签、角标 | 9px 角标、8px slot 标签——**低于标尺** |
| `--text-caption-11` | 11 / 16 | 徽章、meta、对齐 guides | 9–11px 混用（节点状态 9、tab 11） |
| `--text-body-12` | 12 / 18 | 次级 UI、富文本菜单 | 12 = 节点正文/按钮 ✅ |
| `--text-body-13` | 13 / 20 | 密集正文、画布工具条默认 | 13 = 导航/agent 标题 ✅ |
| `--text-body-14` | 14 / 22 | **默认正文、聊天气泡、菜单项** | 14 = `--slk-content-font-size` ✅ |
| `--text-body-15` | 15 / 23 | 画布 prompt 输入（`--canvas-prompt-font-size:15`） | Shotloom composer textarea 12px——**明显偏小** |
| `--text-title-15` | 15 / 22 | 标题 | 15/900 legacy 模态标题（应转 15/400–500） |
| `--text-title-16` | 16 / 24 | 卡片标题、说明主标题 | 无固定用法 |
| `--text-title-18` | 18 / 26 | 分区标题 | 18 页面标题 ✅（但 lh24 ≠ 26） |
| `--text-title-20` | 20 / 28 | 大标题 | 19/28 agent h1（delta 制） |
| `--text-display-24` | 24 / 32 | 展示级 | 22/28 编辑器标题（近似） |

Shotloom 独有的 `--slk-font-delta = calc(content − 14)` 动态缩放是好机制（参考没有，可保留），但**基础档必须钉在上表值上**；8/9px、10.5px、11.5px、17px、34/44 这类越界值全部回收。

**规范**：新增 `--text-*` token 组（字号+行高成对），废弃散点 px；最小可读字号定为 10px，禁止 8/9px。

### 2.3 字重 / 字距

参考：仅 300/400/500/600 四档；**UI 正文与工具条一律 400**，标题 600；字距 token 化（tight −.025em / wide .025em…），画布工具条 `.025em`。
Shotloom：legacy 按钮 12/800、模态 15/900、badge 9/850 与 settings "calm 12px" 400/500、agent 400–650 三制并行；负字距散写（品牌 −.015em）。
**规范**：收敛为 400/500/600 三档 + 特殊 300；≤12px 文字禁止 ≥650 字重（小字重排会糊）；大写 kicker 保留但需带 `--tracking-wide`。

---

## 3. 画布与节点（最重要的对照区）

### 3.1 缩放模型

| 维度 | MiniMax V3（标准） | Shotloom 现状 |
| --- | --- | --- |
| 缩放载体 | React Flow viewport transform（`--canvas-v3-zoom` 运行时发布） | CSS `zoom` 重布局（AGENTS.md 为清晰度刻意选择） |
| zoom 范围 | **min 0.1 / max 4**，fitView padding .2/duration 200 | 0.21 – 3，fitView 0.68 |
| 内容隐藏 | **完全没有阈值隐藏** | <0.8 compact、<0.35 distant、≤0.2 overview 三档隐藏标题/正文/控件 |
| 外壳保持屏幕尺寸 | `zoom: clamp(1, calc(1/var(--canvas-v3-zoom,1)), 2.5)` 反向顶回（node-header-actions 等交互外壳） | 名称标签用 `calc(12px * var(--node-label-zoom,1))` 顺向放大 |
| 描边恒定 | `calc(1px / var(--canvas-v3-zoom,1))`（frame 1px、选中 1.5px、clip 0.75px；命中区 6/8/16px 同样除 zoom） | 边线 `clamp(0.5, zoom, 1.35)`、1px 边框随 zoom 变粗变细 |

**结论**：两种载体（transform vs CSS zoom）不可互换，但参考的"交互外壳反缩放 + 描边除 zoom + 永不隐藏"三原则可以移植到 CSS zoom 体系：在 `zoom` 容器内，外壳用 `calc(1px / zoom)` 即等效。当前 Shotloom 的三档隐藏与 AGENTS.md"低倍率只降透明度、20% 才完全隐藏名称"的规则仍与参考"零隐藏"冲突，是后续画布迭代的主要对齐点（见 §8 P1）。

### 3.2 节点几何（参考值 → Shotloom 值）

| 项 | MiniMax | Shotloom | 判定 |
| --- | --- | --- | --- |
| 媒体节点默认 | 竖图 **360×440**；方形 **350×350**；预览格 240×240；横幅 960×148 | 图 350×350 / 视频 350×280 / 音频 350×125 / 文本 350×500 / 资源 350×150 | 方形一致 ✅；**竖图缺 360×440 档** |
| 节点圆角 | 10px（inner 8） | 10px | ✅ |
| 描边 | 1px 常态、1.5px 选中、随 zoom 反除 | 1px `#e3e3e3`、选中 `rgba(38,43,51,.38)`+1px ring，不随 zoom 修正 | 需补反除 |
| 选中框色 | light `#141414` / dark `#ffffffee` | `rgba(38,43,51,.38)` + 橙框选 `rgba(237,106,53,.46)` | 参考选中/框选同色族，Shotloom 橙色为孤例 |
| 名称标签 | `-top-7`（28px 上偏）、h24、14px/20、gap 4 | top −20px×zoom、h20、12px/550 大写 | 参考标签**更大更近正文**：14px 非大写 |
| 节点 handle | resize 10×10、1.5px 描边圆点；"+" 连接盘 **84×84** 圆形 | 10×10 把手 ✅；out 端口 20×20 "+" | 连接热区参考大 4 倍，触达性更好 |
| 连线 | 1.5px，`#c4c4c4`(L)/`#525252`(D)，hover `#919191`，选中 `#525252`，流动 `#8B72FF`，dash 动画 .5s | `#aab1ad`，宽度随 zoom clamp，无流动色 | 颜色/宽度均需对齐 |
| 画布背景 | `#fafafa`/`#0a0a0a` + 8 组色调预设；点阵 dot = fg 12% alpha | `#fbfbfc` + `rgba(65,70,78,.085)` 点、20px 网格 | 近似 ✅；缺色调预设 |
| 对齐辅助线 | `stroke-width:1`，品牌紫 `#A78BFA`/`--brand-accent`，11px 数字标签 | 无 | 缺功能 |

### 3.3 画布浮动工具条（参考最成套的规范，直接采纳）

```
高度 46px（紧凑 36px） · radius 12px · padding 2px · gap 2px · border 1px
字号 13px/20 字重 400 字距 .025em（紧凑 12px）
图标 16px · 动作 padding 8px（紧凑 6px）
动作高 = 46 − 2×(2+1) ≈ 40px · 动作 radius = 12 − 2 − 1 = 9px
分隔线 高20px × 宽 .5px，两侧 gap 4px · 禁用 opacity .5
底色 --canvas-controls-bg（白 / #1a1a1a）
```

Shotloom `.canvas-node-selection-toolbar`：高 38（30 按钮+4 padding+边框）、radius 14、字号 12/550、图标 16 ✅、分隔线 1×18。
**规范**：radius 14→12；字号 12/550→13/400；分隔线 .5×20；按钮改 padding 驱动（8px 横向）而非固定 h30 r7；紧凑档 36px 对应引入。

### 3.4 节点下方输入面板（work composer ↔ prompt panel）

参考：prompt 字号 **15px**（`--canvas-prompt-font-size:15`）、面板阴影 `0 4px 20px rgba(0,0,0,.06)`、空态 inset 6、输入 padding 6。
Shotloom：textarea **12px**/1.5、radius 14、w = clamp(320, 节点宽−24, 570)、固定在节点下方（AGENTS.md 契约，保留）、`--layer 120`。
**规范**：输入字号 12→14–15；面板 radius 14→12；阴影换 `--canvas-prompt-panel-shadow`；槽位缩略图对齐参考 file-chip **40×40 / radius md(9.6)**（Shotloom 现 36×36 r8，近似）。

---

## 4. 应用壳层布局

| 项 | MiniMax | Shotloom | 判定 |
| --- | --- | --- | --- |
| 菜单/动作列表 | item 高 **36px**、padding 8、radius calc(12×.8)、面板 padding 4、行 gap 2、字号 **14/20** 400、图标 16、图标-文字 gap 8、分隔 margin 4 | 上下文菜单 item 42/13/520 r11、素材菜单 34/13、agent 菜单行 6/8 | 三套菜单三种行高 → 统一 36px/14px |
| 面板宽度 | 弹出列宽反复出现 **260 / 320 / 360**，对话框 620/640 | 节点面板 340、agent 列 384、creation-canvas 330、legacy 310 | 收成 320/360/384→380 一档 |
| 顶栏 | 图标钮 `--topbar-icon-fg rgba(0,0,0,.7)` hover .9 | 40px 高、28×28 钮、svg 16 | 可保留，色入 token |
| 按钮高度 | md 36 / sm ≈24–26（26×26 控件钮、svg≤12）/ 对话框钮 padding-inline 12 + r11.2 | h29 r6 12/800、h32、h36、h38 并存 | 定 28/32/36 三档（现 `--control-height` 32/28 已接近 ✅），字号 13/500 |
| 输入框 | popover prompt 输入 16/24，settings 类输入未见特殊 | h34 r7 / h32 r8 / min-h44 多套 | 输入统一 h32–34、radius 8、字号 13–14 |
| 滚动条 | **隐藏原生**；overlay thumb 黑 22%→35%→42% 三态，transition .15s | 6/9px，thumb `rgba(40,35,31,.18/.32)`（agent）与 `rgba(15,23,42,.14)`（canvas） | agent 已同构，把值统一进 token |
| 图标尺寸 | 12/14/16/20/24/32 六级；工具/检查器 16 | 14/15/16/17/20 混写（导航 17、发送 17） | 收为 14/16/20 主三档 |
| 设置窗 | —（参考为对话式工作台） | 1040×740、nav 172、行 min-h58、输入 h34 | Shotloom 自有，保留，按 §1–2 token 换皮 |
| 遮罩 | dim .5 / 常规 .62 / 媒体 .85，blur 16 | .28 蓝黑、blur 3–6 各异 | 采用参考三档 alpha，中性黑 |

---

## 5. 聊天 / Agent 面板

| 项 | MiniMax | Shotloom | 判定 |
| --- | --- | --- | --- |
| 消息正文 | 14/22 | `--slk-content-font-size` 14 / lh 24+delta | ✅ 基线一致 |
| 输入编辑器 | 14px，padding-y 6，max-height 4lh，placeholder opacity .3 | 14/24，max-h 8×24 | ✅（行高上限不同为产品选择） |
| 文件 chip | **40×40**，radius md | agent chips h28、composer slots 36×36 | 缩略类统一 40/r9.6 |
| mention 标签 | min-h 22、padding 1/6、radius 6；ext 角标 10/600 大写 | 类似 chip 体系 | 近似 ✅ |
| 消息列表节奏 | 见 composer/action-list | 列表 gap 22、pad 20/24、user 行 max-w 460 | Shotloom 自有且成体系，保留 |
| 卡片 | 圆角 radius-lg、按钮 180ms ease | PlanCard/Clarification radius lg(12) ✅ | ✅ |

Agent 面板整体与参考气质相符，主要工作是**把自造 palette（warm-gray + 冷蓝）映射回统一 token**，蓝色至少替换为单一 accent。

---

## 6. 动效 / 焦点 / hover

**时长（参考实测）**：微反馈 .15s；进入 .18–.2s ease-out；节点尺寸 .3s `cubic-bezier(.4,0,.2,1)`；对话框钮 180ms；快速缩放 pop 125/90ms、scale .88、`cubic-bezier(.2,.9,.2,1)`；marching ants .6s、edge dash .5s。`prefers-reduced-motion` 全面降级。
**Shotloom**：120–360ms 散点 + 特色曲线 `.22,1,.36,1`（chrome reveal）与端口 spring `.34,1.56,.64,1`。
**规范**：定 `--duration-fast:125ms / base:180ms / enter:250ms / slow:300ms` 与 `--ease-out:.2,.9,.2,1`、`--ease-std:.4,0,.2,1` 两组；reveal/spring 曲线可保留为画布专属。

**焦点**：参考只有 `--ring rgba(0,0,0,.3)` 一种语言（1px outline + offset 1，或 border 换 foreground + 无阴影）。Shotloom 有 **4 套**（legacy 蓝圈 `rgba(47,111,147,.08)` 3px、settings 黑 3.5%、composer elevation、provider `2px solid #65778c`）→ 必须收敛为一套。

**hover**：菜单项 .03/.06、控件 ~5%/8%、媒体控制 `rgba(0,0,0,.55→.7)`；Shotloom 现 .05/.09/.12 偏重，统一降一档并 token 化。

---

## 7. z-index / 层叠契约（安全底线，非风格）

参考无 token 表，靠 React Flow 内固定层（pane1/viewport2/nodes3/renderer4/panel5/selection6/connection 1001/guides 1002）+ 应用级浮层。
Shotloom 现状约 **25 个散点值**（2–1200），`--layer-canvas-control:80`、`--layer-canvas-composer:120` 两枚 token 基本没被消费，canvas.css 直接硬写 110/115/120/121/18/20/24/30 且 resize 把手用 `!important`。
**规范**（与 AGENTS.md 层叠条款对齐）：画布上下文内固化 `节点 < 选中节点 < 画布控件(80) < 节点输入面板(120)`；应用级只用 3 档：浮层 200 / 模态 400 / 全屏预览 600；所有浮层 CSS 改读 token；删除 `!important`。

---

## 8. 差距清单与整改优先级

**P0 —— 结构性缺口（影响一致性与可维护性）**
1. tokens.css 扩展为参考的完整语义集（含 `.dark` 全量镜像值），组件禁止再写裸 hex/rgba。
2. 字号标尺 `--text-caption-10 … --text-display-24` 落地；清除 8/9/10.5/11.5/17px 与所有无 token 的一次性字号。
3. 字重收敛 400/500/600；废除 legacy 800/850/900。
4. 强调色统一：黑主按钮 + 单一 accent（选 `#6D6CFF/#8B8AFF` 或保留现 agent 蓝但只留一个），清退 legacy 蓝与橙色框选孤例。
5. z-index 契约 token 化并真正消费，移除 `!important`。

**P1 —— 画布对齐参考（结合 AGENTS.md 的 CSS zoom 约束）**
1. 描边/命中区反除：所有节点 frame、resize 线、annotation outline 用 `calc(px / zoom)`，选中 1.5px 恒定视觉。
2. 交互外壳恒定屏幕尺寸：把"名称标签顺向放大"扩展为参考的 `clamp(1, 1/zoom, 2.5)` 式外壳反缩放，覆盖 kicker、节点工具条、端口 "+"（并把连接热区放大到接近 84px 命中盘）。
3. 逐步取消阈值隐藏：0.8/0.35 两档只降细节密度（现有透明度衰减方向正确），≤20% 的 overview 隐藏层向参考"零隐藏"目标收敛——该项与现行 AGENTS.md 条款冲突，需先改约定再改代码。
4. 节点工具条按 §3.3 参考参数重做；prompt 输入 12→14/15px。
5. 连线 1.5px + 参考色 + 流动动画；背景点阵改 `color-mix(fg 12%)`。
6. 竖图节点补 360×440 默认档。

**P2 —— 组件级换皮**
1. 菜单/action-list 统一：36px 行高、14/400 字号、8px 图标 gap、面板 padding 4、radius 12。
2. 按钮 28/32/36 三档、输入 32–34 一档；圆角收 §1.2 刻度。
3. 遮罩三档 alpha、滚动条三态、hover alpha 降档、focus ring 一套。
4. 面板宽度归 260/320/360/(380) 序列。
5. 阴影四档 token 替换全部散写。

> 落地顺序建议：先 P0.1–P0.2（token + 字号，一次 PR 换皮全局），再 P0.3–P0.5，然后 P1 画布（需先对齐 AGENTS.md），P2 随各面板迭代消化。每步以参考值为准绳，测试覆盖 token 引用完整性（无裸 hex）、暗色对照与 55%/100%/180% 缩放回归（AGENTS.md 要求）。
