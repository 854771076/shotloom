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
6. **画布缩放策略不同**——Shotloom 用低倍率阈值隐藏内容（0.8/0.35/0.20 三档）；参考项目对节点内容**零隐藏**，而是对交互外壳做反缩放并把描边除以 zoom，缩放范围 0.1–4×。

> 本节是首轮快照。二次深挖后两点需修正：参考的"零隐藏"只针对节点内容，它在 `zoom ≤ 0.5` 会停绘背景点阵（见 §3.1）；外壳反缩放上限是 `4.35` 而不是 `2.5`，且只用于计数徽标/组标签/prompt chip 三类外壳，节点名称本体仍随画布缩放。上述 1–6 条的当前落地状态见 §10：1（暗色）现在有 token 镜像但没有主题入口，2、3、4 已基本完成，5、6 仍属未完成。

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

**已落地（2026-10-17，见决策 31、32）**：自有 CSS 的 `font-weight` 只剩 400×57 / 500×68 / 600×114 三档（`650`/`750`/`800`/`900` 与一枚 `520` 已并入相邻档；`520` 那档浏览器只会就近取到 Medium，写它等于写 500 还骗人以为有第五档），字距建成四档 em 阶梯 `--tracking-tight/normal/wide/widest`，产品样式里裸 `letter-spacing` 归零并由门禁第 9 条钉住。字阶同样已经是单一来源：504 处 `font-size` 声明里 447 处走 `--text-*`/派生别名，56 处字面量全部位于 vendored 3D 导演台，产品层为 0——只剩一处图标按钮的 `font-size: 0`（隐藏文字用，不是字阶）。
Shotloom：legacy 按钮 12/800、模态 15/900、badge 9/850 与 settings "calm 12px" 400/500、agent 400–650 三制并行；负字距散写（品牌 −.015em）。
**规范**：收敛为 400/500/600 三档 + 特殊 300；≤12px 文字禁止 ≥650 字重（小字重排会糊）；大写 kicker 保留但需带 `--tracking-wide`。

---

## 3. 画布与节点（最重要的对照区）

### 3.1 缩放模型

| 维度 | MiniMax V3（标准） | Shotloom 现状 |
| --- | --- | --- |
| 缩放载体 | React Flow viewport transform（`--canvas-v3-zoom` 运行时发布） | CSS `zoom` 重布局（AGENTS.md 为清晰度刻意选择） |
| zoom 范围 | **min 0.1 / max 4**，fitView padding .2/duration 200 | 0.21 – 3，fitView 0.68 |
| 内容隐藏 | 节点标题/正文/控件**从不隐藏**；唯一停绘对象是背景点阵：`zoom ≤ 0.5` 不再绘制（`JS:7033`，常量 `BF=.5`） | 三档隐藏类（compact/distant/overview）已在工作区删除，TSX 与 CSS 均无残留 |
| 外壳保持屏幕尺寸 | 只对"交互外壳"反缩放，四类实测：节点 header 计数徽标 `zoom:clamp(1, 1/zoom, 4.35)`（`JS:63216,113896`）、组标签 wrapper `scale(1/zoom)`（`JS:113762`）、prompt 引用 chip `zoom = 字号/16`（`JS:34201`）、subject 控件轻度提升 `clamp(1, 0.85/zoom, 1.18)`（`JS:114182`）。**节点名称本体在流内按 `text-sm` 随画布缩放，不反缩放**（`JS:113658`：`-top-7 h-6 gap-1 text-sm`） | 名称标签与外壳均按 `max(1, zoom)` 顺向放大，等效于参考的 transform 缩放 |
| 描边恒定 | `calc(1px / var(--canvas-v3-zoom,1))`（frame 1px、选中 1.5px、clip 0.75px；命中区 6/8/16px 同样除 zoom） | 边线 `clamp(0.5, zoom, 1.35)`、1px 边框随 zoom 变粗变细 |

**结论**：两种载体（transform vs CSS zoom）不可互换，但参考的"交互外壳反缩放 + 描边除 zoom + 节点内容零隐藏"三原则可以移植到 CSS `zoom` 体系：在 `zoom` 容器内，外壳用 `calc(1px / zoom)` 即等效。Shotloom 的三档阈值隐藏已删除，节点内容不再随倍率消失；剩余缺口是**描边/命中区没有 `÷zoom` 修正**（全仓 `calc(1px / …)` 零命中），以及反缩放只覆盖了名称标签、未覆盖 header 徽标/端口/连线的命中区。

参考的"隐藏"只有一处合法先例，且不属于节点内容：**背景点阵在 `zoom ≤ 0.5` 停绘**。这条对 Shotloom 的启示是——纯装饰的画布底纹可以让倍率决定是否绘制，但节点内的标题、正文、控件、端口不行。

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
**规范**：输入字号 12→14–15；面板 radius 14→12；阴影换 `--canvas-prompt-panel-shadow`；槽位缩略图对齐参考 file-chip **40×40 / radius md(9.6)**——已落地为 `--canvas-slot-size`，见 §10 决策 28；缩略图行的让位也从写死 160 改成按触发器尺寸派生，见决策 30（本条其余三项此前已落地）。

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
**规范**（与 AGENTS.md 层叠条款对齐）：画布上下文内固化 `节点 < 选中节点 < 画布控件(110) < 节点输入面板(120)`；应用级只用 3 档：浮层 200 / 模态 400 / 全屏预览 600；所有浮层 CSS 改读 token；删除 `!important`。`--layer-canvas-control` 的唯一取值是 tokens.css 的 110（本文档早期版本写 80，已按代码更正）。

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

---

## 9. 参考规范细化（2026-10-17 二次深挖，逐条实测）

> 证据缩写（行号取自 minified 产物的展开视图，文件与参考包同名）：
> **I-CSS** = `app/out/renderer/v3/assets/index-D20guzI6.css`；**C-CSS** = `CanvasPage-BmZNABX4.css`；
> **JS** = `CanvasPage-MuABU4gC.js`；**EDITOR** = `EditorInterface-DPuUFKiL.js`；**CHAT** = `ChatPage-O-1coU0A.js`。
> 本轮补充的结论均经再次抽查（`--spacing:.25rem`、action-list 36/14/8/16、toolbar 46/12/2/13/16、`Pl=.1,wa=4`、`-top-7 h-6 text-sm`、`Nr=620`、滚动条 `#00000038/59/6b`）。

### 9.1 图标系统（Shotloom 完全没有这一层）

| 项 | 参考实测 | 证据 |
| --- | --- | --- |
| 默认尺寸 | **16px**：菜单/动作列表/画布工具条/按钮内 `[&_svg]:size-4` | I-CSS:1851、I-CSS:910、JS:131674 |
| 完整档位 | 12（价格/credit 角标）· 14（icon-xs 按钮、节点类型图标）· 16（默认）· 20（动作盒内基准盒）· 24 · 32 | I-CSS:911、JS:113660、I-CSS:1137-1145 |
| 图标基准盒机制 | action-list 图标一律按 **20px 内盒**渲染，再 `scale(icon-size / 20px)` 缩到目标档 → 描边粗细随档位线性变化，不会小图标糊成一团 | I-CSS:1137-1145 |
| stroke-width | **1.5** 为绝对主流（三 bundle 共 235 次），2/1.75/1.25 只用于强调与极小档；文件类型 badge 描边 2.2 | EDITOR/JS/CHAT 统计 |
| icon-only 按钮盒 | 壳层 `32×32 rounded-md hover:bg-muted`；画布工具条 `40×40`（= action-height 计算值，纯图标时宽=高） | EDITOR:36148、I-CSS:1069-1072 |

### 9.2 组件几何（可直接抄的参考原值）

| 组件 | 参考值 | 证据 |
| --- | --- | --- |
| Switch | sm `28×16`，padding 2，thumb `12×14`，位移 10；default `40×20`，padding 3，thumb `14×18`，位移 16；未选 `bg-input`，已选 `foreground/65` 或 `--brand-accent`，thumb `ring-1 ring-foreground/5`；扩展点击区 `after:-inset-x-1 -inset-y-2`；`transition-transform 150ms ease-out` | JS:9718-9723 |
| Tabs / 分段控件 | 轨道 `h-40 bg-muted p-4 radius-9.6`，trigger `px-12 py-6 text-14 radius-sm`，激活滑块 `bg-background shadow-sm` + spring `{stiffness:500, damping:30}`，content 入场 `opacity 0, y 4 → .15s`；资源模式切换整体 **30px**、thumb 20px、按钮 `h-20 px-8` | JS:133116-133146、I-CSS:3489-3500 |
| Tooltip | `max-w 260`、`px-8 py-4`、**11px**、`shadow-md`、底 `rgba(20,20,20,.92)`（`--canvas-tooltip-bg`）、白字、`z 10002`、距锚点 6px、视口边距 4px | JS:106932-106942 |
| Toast | `min-h calc(2lh + 12px + 2×0.5px)`、`px-12 py-6`、12px、gap 12、radius 12 + 1px 边；入 `.18s ease-out translateY(6px)`，出 `.16s ease-in` | I-CSS:3359-3392 |
| Checkbox | 三档 `16/20/24`，点击目标 `28/32/44`（粗指针统一 44），backplate bleed 2px；动画 fill `.12s`、draw `.16s cubic-bezier(.2,0,0,1)` | I-CSS:1966-1996、2106-2110 |
| Slider | 标准轨 4px、thumb 14px、控件高 44（紧凑 24）、focus `outline:2px solid ring; offset 3px`；圆轨变体轨道 16px、thumb 16/18px | I-CSS:2333-2378、2477-2521 |
| 分隔线 | 基准 `--divider-width: .5px`（画布控件内一律用 .5px，不是 1px） | I-CSS:3537、916 |
| 滚动条 | 原生隐藏；overlay thumb 厚 **6px**、margin 2px、轨道 10px、内缩 3px、最短 thumb 24；色 `#00000038` → hover `#00000059` → drag `#0000006b`（暗色白同 alpha），`transition .15s` | JS:83731-83822、I-CSS:400-417 |
| 模态/浮层宽度档 | sm **384**、md **448**、4xl **896**（max-h 85vh）、媒体查看器 `min(960px,90vw) × min(660px,78vh)`、i2v popover **620**、billing popover 264/288 `radius-16 p-1`；dialog content `grid gap-16 p-16 radius-12 ring-1 foreground/10` | JS:14655、EDITOR:2550、JS:15817、JS:61531 |
| 右侧检查器 | **280px**（`grid-cols-[minmax(0,1fr)_280px]`） | JS:15828 |
| 顶栏 | 高 `h-10`(40) + `px-8`，三段 `grid minmax(0,1fr) auto minmax(0,1fr)` | EDITOR:34187 |
| 空态 | 12–13px muted；节点建议行 `h-32 px-12 14px font-light` | EDITOR:6877、36116、JS:88537 |

### 9.3 按钮 / 输入框：参考自身有两代，标准取"新那一代"

**共享 Button cva**（JS:123663-123670）：base `gap-8 · radius-md(9.6px) · 14px · 500 · [&_svg]:size-4`，focus-visible `ring-2 ring-ring ring-offset-2`，disabled `opacity-50`；尺寸 default `h-40 px-16 py-8`、sm `h-36 px-12`、lg `h-44 px-32`、icon `h-40 w-40`、icon-sm `h-32 w-32 svg16`、icon-xs `h-24 w-24 svg14`；主按钮 `bg-primary(#000) text-#fff hover/90`，outline 用 `--input` 边 + `hover:bg-accent(#f5f5f5)`。

**壳层自定义 chrome 按钮**（实际更常用，EDITOR:36148）：`h-32 px-8~12 gap-6 radius-md 13px 字距 -.52px text-foreground/70 hover:bg-muted`，过渡 **75ms**；pill chip `h-32 px-10 gap-6 radius-full bg-muted 13px 500`。

**Input（现行 `data-slot=input`，JS:8610）**：`h-32 w-full radius-md border --input px-10 py-4 12px`，placeholder `muted-foreground`；**焦点不加阴影 ring，而是把边框换成 `border-foreground` 且 `ring-0`**；disabled `bg-input/50 opacity-50`；搜索图标内缩 8px、输入 `pl-32/pr-32`。旧 shadcn 版（`h-40 text-14 ring-2`）仍打包但已不是方向。

> 结论对 Shotloom 的直接意义：`--control-height` 32/28/36 三档是对的，但 **focus 语言只有一种**——要么 `outline:1px solid var(--ring); outline-offset:-1px`（画布控件），要么"边框换成前景色、不加环"（表单输入）；绝不允许 3px 阴影圈。当前全仓 28 处 focus 写法/6 套色必须按此收敛。

### 9.4 菜单分"应用级"与"画布内嵌"两档，不能混用

| 档 | 参考值 | 证据 |
| --- | --- | --- |
| 应用级 action-list（唯一标准） | 面板 `padding 4 · row-gap 2 · border 1px · radius 12 · shadow 0 8px 32px #00000014,0 2px 8px #0000000a`；行 **36px 高**、`padding 8`、`gap 8`、图标 16、行 radius 9.6、**14px/400/20 行高**；hover `--canvas-controls-hover`；separator 1px `margin 4`；disabled `.5`；行过渡 `background-color .15s, color .15s` | I-CSS:1833-1935 |
| 画布内嵌下拉 | 项 `padding 12/8`、`gap 10`、**12px**、radius-sm、过渡 **80ms**；分隔 `mx-4 my-4 h-px`；面板 `min-w-128 p-4 radius-12` | JS:35162-35199 |
| 画布右键菜单 | `min-w-192 animate zoom-in-95`；灯箱版 `min-w-176 radius-12 p-4 text-12`，项 `h-32 px-10 radius-md gap-8` | JS:105478、91986-92009 |

> 这条修正了本文档 §8 P2.1 的一刀切："菜单统一 36px/14px"只适用于**应用级**；画布内的 param/model/preset/ratio 菜单应当走 12px、行高 ~28–32 的画布档。Shotloom 现在两套都不是参考值。

### 9.5 参考的宽度序列（布局对齐用）

`260（tooltip）· 280（检查器）· 288/286（浮层）· 384（sm）· 448（md）· 620（prompt 面板 = i2v popover）· 896（4xl）· min(960,90vw)（媒体）`；Tailwind 容器 token 只编译了 xs 20 / sm 24 / md 28 / 3xl 48 / 4xl 56 / 5xl 64 / 7xl 80（rem）。
Shotloom 现存 168/190/220/260/280/304/310/320/340/380/390/420/520/540/620/720/760/820/900 散点，必须归入上面这条序列（节点输入面板可保留"节点宽−24"算法，但上限应取 620 与参考一致，见 C-CSS/JS:95661 `Nr=620`、锚点 `节点底 +16`）。

### 9.6 动效补全

默认 `.15s cubic-bezier(.4,0,.2,1)`（I-CSS:3745）；chrome 按钮 75ms、画布内菜单 80ms、菜单/控件 hover 150ms；弹层 quick-zoom **入 125ms / 出 90ms**，scale .88，`cubic-bezier(.2,.9,.2,1)` 与 `(.4,0,1,1)`（I-CSS:646-651）；dialog `zoom-in-95 100ms`；toast 180/160ms；checkbox fill .12/draw .16；tabs spring 500/30；生成中 shimmer `2.6s linear`、queued 描边脉冲 `2.4s ease-in-out`；`prefers-reduced-motion` 在 10+ 处统一降级为 `.01ms/none`。

### 9.7 字号下限的事实修正

参考的**成对标尺最小是 10/14**，但包内确实存在 `text-[8px]`（EDITOR 23 次、JS 1 次），全部是刻度/角标类微标注，不进入正文体系。Shotloom 已把 8/9px 清零，保持"正文最小 10px"这条更严格的规则即可，不需要为 8px 开档。

---

## 10. 迁移落地率与工作区现状（2026-10-17 复核，未提交）

**实测落地率（24 个 CSS 文件全量脚本统计）**

| 维度 | 现状 | 上一轮 |
| --- | --- | --- |
| `font-size` | 456 处 / **431 处（94.5%）** 直接写 `var(--text-*)`，其余 25 处是 `--canvas-node-*-size`、`--ov-ui-font-size` 这类角色别名，别名本体全部回指阶梯；**阶梯外字号 0 处**（`tests/design-token-contract.test.mjs` 静态扫描，含一层间接） | 48 处（9.2%）、agent-chat 16 处越界 |
| 字体名 | 20 处 `font-family` 声明，全部是 `var(--font-*)` 或 `inherit`；产品 CSS 里 0 个字面字体名，`font:` 简写也不夹带字体族 | 硬栈 8 行 + 复制栈 11 处 |
| 配对行高 | 66 处消费 `--text-*--line-height` | 12 处 |
| `border-radius` | 384 处 / 246 处直接走 `--radius*`，29 处走 `--slk-radius*`（已改成派生档），99 处是 999px/99px/50%/inherit/0 纯形状，3 处是随语义缩放的 `calc(…px * var(--node-label-zoom))` 几何；**刻度外圆角 0 处** | 387 处 / 245（63.3%），另有 4 处字面刻度值 |
| 图标 | `--icon-xs…2xl` 六档，`--action-icon-size` 指向 `--icon-md`，工具条 svg 统一 `--icon-sm`；多余的 `--icon-stroke` 删除（图标自带 per-path 描边宽度）；svg 宽度档 19 → 13（剩余为 vendored 3D director 与媒体覆盖层）；节点图标/操作尺寸别名改为 `--icon-xs`/`--icon-lg` | 19 档、token 零消费 |
| hex 残留 | tokens.css（57）之外只剩 **13 处**，全部是 `.ov-editor` 里成对声明的时间线轨道分类色；TSX 侧只剩第三方 API 值与用户可编辑的素材数据（NodeResizer `color`、logo 填充、字幕颜色默认值），界面 chrome 不再写 hex；vendored 3D director 19 处按第三方处理 | 686 处，剪辑区 440 |
| α 字面量 | tokens.css 79 处 α 定义之外，自有 CSS 还有 **98 处** `rgba()/rgb()` 用在颜色/填充上（逐字 `rgba?(` 统计，排除 tokens.css 与 `/vendor/`；project-materials 26、canvas 20、styles.css 16、media-overlays 8、剪辑四层 13、settings 5、creation-view 3、对话层 7、agent-theme 1）；**阴影里的 α 字面量 0 处**：148 处 `box-shadow` 声明 = 34 处 `none` + 走档位/颜色 token + `color-mix()` 从状态色派生，字面颜色 0 处。（上一版此行的 183 是更早一次宽口径统计，本轮改按逐字 `rgba?(` 重算，并随死 CSS 删除 −2） | 未统计 |
| token 引用 | tokens.css **157 名 / 214 声明**（含 `.dark` 镜像；本轮新增 `--tracking-normal`、`--tracking-widest` 两枚），零消费的仍然只有 `--text-display-24--line-height` 一枚（标尺成对保留），且这条现在是**门禁第 8 条机器判定**（遍历自有 CSS+TS，每档必须有 `var()` 消费者）；`--canvas-edge*`、`--overlay-*`、`--layer-*`、13 档阴影、9 档 motion、3 档浮层动作、槽位档、触发器让位档、4 档字距全部有消费 | 189 枚、36 枚零引用 |
| 层级 | 应用级 11 处走 `--layer-*`；其余 88 处 `z-index` 字面量是 0–30 的组件内相对层级，不属于应用级契约 | 分层只在画布内落地 |
| `!important` | 自有 CSS 33 处（原 39），集中在标注编辑器对第三方 `.screenshots-*` 的覆盖，以及 React Flow handle——后者实测必须保留：库把 `background-color`/`border-color` 写成行内样式，只有 `!important` 压得住 | 39 处 |
| 描边 ÷zoom | `--canvas-hairline: calc(1px / var(--canvas-node-zoom))` 已进节点卡、虚线工具节点、媒体框与资源按钮 | 0 处 |
| 墨色 | 4 档 1 个词汇表：`--text` #000（参考实测主文字）/ `--type-primary` .82（内容墨）/ `--muted` .5 / `--faint` .32，外加独立的 `--fg-disabled` .35/.3。`--type-secondary`、`--type-tertiary` 两枚**逐值相同**的别名删除，136 处引用并回 `--muted/--faint`（两套主题计算值一致，视觉零变化）。浏览器 WCAG 实测：页面上 <4.5:1 的文本只剩输入 placeholder(.32) 与节点空态描述(.5) 两处，而这两处正是参考定义的值（placeholder opacity .3、空态 12–13px muted）；画布悬浮条统一到 .82 后，10px 缩放读数从 3.94:1 升到 13.19:1 | 同一色阶两套命名并存（`--type-*` 308 处 / `--muted·--faint` 157 处），且真实状态值（缩放百分比、参数摘要、建议按钮）压在 .5/.32 上 |
| 动效 | 72 处 `transition` 声明 = 8 处 `none`（reduced-motion 与隐藏态）+ **64 处全部引用 `--duration-*`/`--ease-*` 或 `--slk-dur*`/`--slk-ease` 别名**；档位外时长/曲线 0 处。19 处 `animation` = 6 `none` + 5 处一次性入场（drawer 明细、素材浮层、灯箱升起、侧栏明细进/出）全部走档位 + `--duration-stagger` 错位 + 显式曲线（原先两条侧栏入场连曲线都没写，默认落在裸 `ease`）+ 8 处无限循环（spin/pulse/sweep/marching-ants/骨架微光）按契约保留自身周期与 `linear` | 时长 94 处动效声明、24 个时长字面量（80/100/120/140/150/160/180/220/300ms 与 `.12s`–`.3s` 两种单位混写）、3 种私有贝塞尔加裸 `ease`/`ease-out` |
| 控件档位 | 应用级控件 `--control-height-compact/-/large` = 28/32/36；画布浮层的**动作高度不再自写**，由条高派生：`--canvas-toolbar-action: calc(46 − 6)` = 40、`--canvas-toolbar-action-compact: calc(36 − 6)` = 30，分隔线厚度统一为 `--toolbar-divider-width: .5px`。浏览器实测：节点工具条 46（描边 1 + 内边 2 → 内腔 40）里三个图标动作与名称标签都是 40，缩放条 36（描边 .5 + 内边 2 → 内腔 31）里 `−/%/＋` 全部 30×30、分隔线计算值 0.5px；剪辑顶栏 36 行里历史图标按钮与右侧文字按钮同为一档 28，品牌标记取 `--icon-xl` 24；生成节点输入行的缩略图/添加位/发送钮另立一档 `--canvas-slot-size: 40`（参考 file-chip 40×40，与条高派生的 40 只是数值相遇、语义分名），实测输入行 40、发送钮 40 正圆，且 `:empty` 让纯文本生成节点不再白占一整档行高；设置窗口整窗实测控件高度只有 34（输入/选择）与 36（按钮）两档，无越档高度，导航行图标 14 配文字 18.5 属正常基线差 | 缩放条 32 动作顶穿 31 内腔、节点分隔线 1px、剪辑顶栏 26/27 相邻错边、品牌标记 23、槽位 36 且空行白占 40px |
| 字距与字形档位 | 字距四档 em（`--tracking-tight/normal/wide/widest`）覆盖自有 CSS 的全部 24 处 `letter-spacing` 声明（`renderer/styles/` 11 + `styles.css` 5 + `src/` 8），全部是 `var()`，裸数字 0 处；对话层图标字形按 `getBoundingClientRect` 实测只余 12/14/16/24 档内取值，档位外的 11/13/15 已清除，两级层次（头部 sm、行内 xs）由门禁第 9、10 条钉住。vendored 3D 导演台另有 56 处 `font-size` 字面量，不参与产品规范 | 同一类小标签在四个面板里各挑一个数字（.01/.02/.03/.04/.08/.13/.16em），对话卡片箭头 11/13 与同排图标 14 混排 |

**本轮定版并已实现的判断**

1. `.dark` 镜像：保留为"只有 token、没有开关"的一层（应用仍固定浅色），并补齐状态色镜像；不再单独提供深色入口。
2. `--layer-canvas-control` 钉为 **110**，§7 已按代码更正。
3. 菜单两档：应用级 36 / `--text-body-14`，画布内嵌 ~28–32 / `--text-caption-*`。
4. 全站只留一套灰阶：Agent 面板的 `--slk-static-*` 暖灰改为直接指向产品 token（`--surface/--bg/--surface-2` 与中性 `rgba(0,0,0,α)` 边框、wash），对话区不再与其余窗口呈两套色温。
5. 状态色收敛为 `--good/--warn/--bad` + 各自 `*-wash`（低彩度 + `.dark` 镜像），替换掉技能、厂商、配方面板里并存的 5 种绿与 3 种红橙。
6. 全局滚动条语言：`* { scrollbar-width: thin; scrollbar-color: var(--scrollbar-thumb) transparent }`，需要隐藏滚动条的面板局部覆盖。
7. legacy 画布 CSS（`.canvas/.node-layer/.edge-svg/.node*` 共 104 行）删除，不留兼容层。
8. 连线与箭头取色收回到 CSS：`canvas.css` 用 React Flow 的主题变量入口（`--xy-edge-stroke/-width/-selected`、`--xy-connectionline-stroke`）注入 `--canvas-edge*`，`<ReactFlow defaultMarkerColor="">` 让箭头不写行内 stroke/fill，`.react-flow__arrowhead polyline` 由 CSS 上色。TSX 里不再出现 `stroke`/`strokeWidth`/`#c4c4c4` 字面量，edge 对象的 memo 也不再依赖 `semanticZoom`——缩放不重建连线、低倍率不再给连线降透明度（原先 0.48/0.72 三档隐藏）。浏览器实测：连线 `rgb(196,196,196) / 1.5px`，选中 `rgb(82,82,82)`，箭头 stroke+fill 同源。
9. 字体家族只有三个入口：`--font-ui`（body 与全站默认）、`--font-mono`（代码/参数/等宽回执）、`--font-serif`（正文编辑器与文本查看器：Georgia → 宋体 → Noto Serif CJK）。原先 body 的 8 行硬栈、7 处 mono 复制、以及 Georgia/`"Songti SC"`/`"Noto Serif CJK SC"` 四处分散写法全部删除。
10. 媒体层（灯箱与文本查看器）统一到三档白墨 + 一档黑面：`--overlay-ink`(#fff) / `--overlay-ink-muted`(α.72) / `--overlay-ink-hint`(α.46) / `--overlay-surface`(α.8)。替换掉原先同一屏上并存的 9 种冷灰白文字（#eef3f7/#f5f8fa/#e6edf2/#dce6ec/#a9c1cf/#9fb1bc/#9aabb5/#758895/#fff）与 4 种黑底 α（.72/.86/.88 与蓝味的 `rgba(13,19,25,.88)`）；重复的 `--media-overlay-foreground/-surface-strong` 删除，画布内的媒体标签改指同一色阶。
11. 图标语言补齐到富文本工具条：MediaViewer 的格式按钮不再用 `•<i>≡</i>`、`<small>1</small>`、`▦`、`—` 这类靠 8px/10px 字号和 `letter-spacing:-2px` 撑出来的伪字形，改用 `IconSymbol` 的 `bold/italic/text/list-bullet/list-ordered/minus/table`（14px = `--icon-sm`，与全站同源）；只有 H1/H2/H3 作为标题级分组保留衬线文字。逐个 `getBBox` 实测：墨迹范围 3.4–21 × 3.8–21（viewBox 24），三行数字中心 6.15 / 12.15 / 18.5，与 6/12/18 的行线对齐。

12. 应用级层叠阶梯收口：`--layer-canvas-control 110 / --layer-canvas-popover 115 / --layer-canvas-composer 120 / --layer-overlay 200 / --layer-modal 400 / --layer-workspace 500 / --layer-toast 600`。修掉真实缺陷：`.toast` 原本 `z-index: 60`，会被遮罩(200)、项目搜索(400)压在下面，而设置工作区写的是逃逸标尺的 1200；现在工作区 = `--layer-workspace`、通知 = `--layer-toast`，creation-view 的画布浮层用新登记的 115 档。组件内部 0–30 的相对层级不并入这套契约。
13. 对话面板字号回到全局阶梯（60 处 calc / 私有别名换成 token）：删除 `--slk-font-delta`、`--slk-font-secondary`、`--slk-code-delta`、`--slk-content-font-size`、`--slk-code-font-size`——`--slk-content-font-size` 从未被覆盖，delta 恒为 0，只会产出 10.5 / 12.5 / 17 / 19 这些阶梯外尺寸。markdown 标题改为 20 / 18 / 16 并取配对行高；行内代码与代码块统一 `--text-caption-11`，不再用 `0.875em` 从正文算出 12.25px。排版行高（14/24、13/22）按原值保留，因为那是行的呼吸而不是字号标尺。
14. 对话面板只剩一层语义别名：`--slk-static-*` 整层删除（它已退化成一串纯别名），第二套灰阶（#1a1a1a / #585858 / #808080 / #a3a3a3 / #d4d4d4）与第二套 UI 字体栈（Segoe UI / Hiragino / 微软雅黑）一并删除。primary→`--text`、secondary→`--muted`、tertiary/caption→`--faint`；三档描边→`--line-soft/--line/--line-strong`（`--slk-border-l4` 取消，发丝描边回到产品最强的一档）；三档 hover→`--popup-item-hover/--canvas-controls-hover/--button-subtle-hover`；黑色按钮→`--brand`（与应用 `.button.primary` 同一对语义，反相墨用 `--surface`）；琥珀/红底→`--warn-wash/--bad-wash`；深琥珀文字与 accent hover 用 `color-mix()` 从同一个状态色 / 品牌色推导，不另取 hex。`--slk-font-family` 的 15 处与 `--slk-font-code` 的 7 处改指 `--font-ui/--font-mono`。浏览器实测别名解析：`rgb(0,0,0)` / `rgba(0,0,0,.5)` / `rgba(0,0,0,.32)` / `color(srgb .46 .29 .09)` / `rgba(109,108,255,.08)` 全部到位，agent-theme.css 现在 0 hex。
15. 死代码清除：`settings.css` 中没有任何消费者的 `.model-guide-*`（55 行，含其 720px 媒体查询）、零引用变量 `--ov-workspace` / `--ov-accent-soft` / `--canvas-node-head-size`。同时修掉 vendored 3D 视口里 `rgb(var(--muted-rgb))` 的未定义引用（正确名是 `--text-muted-rgb`；未定义会让整条 `color` 声明失效，错误卡片文字一直没按预期着色）。
16. 音频播放器的 6 处 `!important` 改为选择器加权（`.audio-waveform-controls .audio-waveform-play/-download`），实测计算样式前后一致（999px 圆、白墨、黑面、绝对居中、26px），不再靠优先级压制。
17. 圆角刻度只剩一个来源：`--radius: 12px`，其余全部 `calc()` 派生（`--radius-xs .35 → 4.2`、`-sm .6 → 7.2`、`-md .8 → 9.6`、`-lg 1 → 12`、`-control .85 → 10.2`、`-xl 1.4 → 16.8`、`-2xl 1.7 → 20.4`）。对话面板那套私有刻度（4/8/12/16/20/28）删除，`--slk-radius-*` 改成按用途映射到派生阶：面板 20.4、卡片 16.8、控件 7.2、标签 4.2——浏览器实测 `_card_` 计算值从 20px 变成 `calc(12px * 1.7)`。同时按 corner 逐个校验（不是整条 value 里只要出现过 `--radius` 就算合格），揪出 `project-materials.css` 里 3 处 `var(--radius-sm) 9px 9px 9px` 这类混写并补齐；3px 宽的播放头指针改 `999px`（渲染完全一致，但不再往纯形状上贴刻度数字）。
18. 模态框抬升收口：新增 `--shadow-modal`（浅色 `0 24px 70px rgba(0,0,0,.18) + 0 4px 14px rgba(0,0,0,.06)`，`.dark` 镜像 .5/.35），`.modal`、剪辑覆盖层工作台与更新对话框三处原来各自手写的 `0 24px 70px rgba(0,0,0,.22)` / `.20` 统一到这一档——浮在暗色遮罩之上的层必须比面板深，否则和遮罩一起塌成一层。`.update-modal` 从"重写一整套圆角/底色/阴影"降级成 `.modal` 的宽度变体（`min(456px, …)`），头部关闭按钮用 `--radius-control` + `--canvas-controls-hover`。
19. 画布第三人称色板归位：缩略图去掉 TSX 硬编码的 `nodeColor="#b9bcc0"` 与暖白 `maskColor="rgba(250,250,248,.72)"`，改走 React Flow 自己的变量入口 `--xy-minimap-node-background-color: color-mix(in srgb, var(--text) 30%, transparent)`、`--xy-minimap-mask-background-color: color-mix(in srgb, var(--canvas-controls-bg) 72%, transparent)`（实测 `rectFill = color(srgb 0 0 0 / .3)`、`maskFill = color(srgb 1 1 1 / .72)`，深色镜像自动反向）；工具节点卡片从 `rgba(255,255,255,.9)` 回到 `--surface`，选中态并入媒体卡同一契约（`--canvas-node-border-selected` + `0 0 0 1px --canvas-selection-bg`），不再让画布上存在两种"选中"；错误态光晕从 `rgba(183,53,53,.14)` 改成 `color-mix(in srgb, var(--bad) 14%, transparent)`。节点字号别名（title/body/meta/hero/icon/error）全部指向 `--text-*` / `--icon-*`，画布不自立尺寸刻度。
20. 死 CSS 清除：`styles.css` 里没有任何 DOM 消费者的 `.image-work-node`、`.image-work-node.selected`、`.image-node-label`、`.image-node-plus`、`.image-placeholder`（含其 svg）共 52 行删除。
21. 新增仓库级契约门禁 `tests/design-token-contract.test.mjs`（10 个 test）：遍历自有 CSS（排除 `/vendor/` 与 tokens.css），先建 token 定义表并解析一层别名间接，断言十条——字号只能取 `--text-*`/`--icon-*`（或经已定义变量间接指向它）、圆角只能取 `--radius*`/纯形状/语义缩放几何、`font-family` 与 `font:` 简写不许出现 SF/PingFang/Georgia/Consolas 等字面字体、tokens.css 之外零 hex（`.ov-editor` 13 处调色板除外）、`box-shadow`/`drop-shadow()` 的值里不许有颜色字面量且 13 档阴影必须在 tokens.css 有定义、动效档位（见 25）、浮层动作高度与分隔线厚度（见 27）、**档位不许"定义了却没人用"**（见 28）、**字距只走 tracking 档**（见 31）、**对话层图标字形只走 --icon 档**（见 32）。tokens.css 自身也断言"派生阶不允许写 px 字面量"，对话面板断言抬升只能借产品档位。字号/圆角/字体/hex/抬升/动效/浮层动作/档位消费/字距/字形十项从"这轮手工改完"变成"新代码写错就红"。
22. 抬升收成一档一位、只写一次：tokens.css 的阴影档位现在是 `--shadow-card`（静止卡片 `0 1px 2px rgba(0,0,0,.05)`）/ `--shadow-lift`（hover 抬起 `0 8px 24px .08`）/ `--canvas-shadow-panel`（画布控件条 `0 2px 5px .08`）/ `--canvas-shadow-dropdown` / `--canvas-shadow-menu` / `--canvas-prompt-shadow`（输入卡）/ `--shadow-float`（画布内屏幕空间浮层 `0 18px 44px .1`）/ `--shadow-cast-right`、`--shadow-cast-up`（停靠面板朝内容投的方向性投影——方向是语义，不是装饰，所以两向分开）/ `--shadow-modal`（遮罩之上）/ `--overlay-cast`、`--overlay-hairline`（素材上的白墨控件）与 `--drop-shadow-sm`。全仓 43 处自写阴影数字并入这些档位，实测 147 处 `box-shadow` 声明中 α 字面量 0 处。顺带修掉三个真实缺陷：三处**不同色温的落影**（`rgba(40,40,40,.08)`、`rgba(42,35,30,.08)`、`rgba(30,25,22,.24)`，中性黑旁边混着暖灰阴影）、`.project-folder-glyph` 上那枚 `inset 0 1px rgba(255,255,255,.7)` 高光（拟物残留，卡片靠描边+落影分离就够了）、以及同一个灯箱控制条的三种手写阴影（`.2`/`.22`/`.2`）。
23. 对话面板的发丝抬升并入产品档位：`--slk-elevation-panel` = 0.5px 描边 + `--shadow-card`，`--slk-elevation-prominent` = 描边 + `--shadow-lift`，`--slk-elevation-soft` 删除（它与 `-panel` 的柔光差是 `.03/.02` 对 `.03/.03`，本来就落在感知阈值以下；输入卡片静止用 `-panel`、聚焦用 `-prominent`，聚焦时现在真的会抬起来）。发丝描边这层保留——它承担分离，正是参考的做法。
24. 焦点与选中各只留一种语言：全局 `:focus-visible` 是 `2px solid var(--ring)` + offset 1（参考的 1px 是给"边框换前景色"的表单输入，不是给环——`rgba(0,0,0,.3)` 的 1px 环在 `#fafafa` 上只有约 2.2:1，键盘焦点几乎看不见，所以环用 2px、输入用边框，两条各归其位），被容器裁切的地方按 inset 同权重写（`.provider-list-row/-back` 从 `1px/-1px` 提到 `2px/-2px`，与画布输入卡、抽屉分隔条一致），表单输入继续用"边框换成前景色、不加环"；顺手修掉一个真实缺陷——富文本行内输入框聚焦时只把边框从 `--line-solid` 换成 `--line-strong`（8% 黑），看上去等于没聚焦，已改为 `--text`。选中语言：删掉 `.canvas-edge.selected .edge-visual` 的紫色光晕 `drop-shadow(0 0 3px rgba(109,108,255,.3))`——画布节点、工具节点、连线的选中全部是中性灰（描边 `--canvas-node-border-selected` + `0 0 0 1px --canvas-selection-bg`，连线 `#c4c4c4 → #525252`），只有连线在发紫光。

25. 动效刻进最后一层私有刻度：tokens.css 的 Motion 块是唯一来源——时长 `--duration-fast 125ms`（hover/变色这类微反馈）/ `-base 180ms`（进出与淡入）/ `-enter 250ms`（面板宽度、位移）/ `-slow 300ms`（要被看见的尺寸变化）/ `-stagger 45ms`（编排用的错位延时：容器先动、内容随后落位），曲线 `--ease-out`（.2,.9,.2,1）/ `--ease-std`（.4,0,.2,1）/ `--ease-sheet`（.22,1,.36,1，面板与抽屉的展开手感）/ `--ease-pop`（.34,1.56,.64,1，只给画布控件的弹性入位）。全仓 94 处动效声明、24 个时长字面量并成 5 档时长；对话面板的私有 `--slk-dur*`（.1/.2/.3s）与 `--slk-ease` 保留为角色别名，但只指向产品档位，实测解析后与全局同值。修掉的真实缺陷：5 处一次性入场动画里，侧栏明细进/出两条**根本没写曲线**，落在浏览器默认 `ease`（两头都慢、中间快），和同屏用 `--ease-sheet` 的抽屉宽度不是同一种手感；素材浮层的 `cubic-bezier(.2,.8,.2,1)` 与灯箱升起的 `.22,1,.36,1` 各自写死，140/220ms 的时长也和邻居们的 150/180/200ms 混在一起。契约里明确豁免：8 处 `infinite` 循环（spinner、脉冲、marching-ants、骨架微光）的周期与 `linear` 属于动画本身的物理量，不是 UI 时长档，强行套 `--duration-*` 只会把"转一圈多久"伪装成"过渡多快"。门禁按**声明**扫描而不是按行扫描，跨行写法的续行同样被抓；剥离 `var()` 之后才判断，所以 `--ease-std` 这种令牌名不会被误判成裸关键字。

26. 墨色只剩四个角色，且信息级文字不许比内容级更轻：tokens.css 的 ink 块为 `--text`（满前景，参考主文字实测就是 `#000`，我们此前也同值）、`--type-primary rgba(0,0,0,.82)`（内容文字）、`--muted .5`（次要说明）、`--faint .32`（占位与空态）四档；`--fg-disabled rgba(0,0,0,.35)` 单独保留，因为它在 `.dark` 里镜像成 `.3` 而 `--faint` 镜像成 `.42`，两档深色并不重合，合并会让禁用态在深色主题下变亮。删掉 `--type-secondary` / `--type-tertiary`——它们在两套主题里与 `--muted` / `--faint` 逐值相同，只是同一把梯子上的第二套词汇，136 处引用跨 11 个文件批量并入后视觉零变化。真正的缺陷只有把页面渲染出来才算得出来：同一块悬浮白底上，节点工具条用 `.82`、缩放条却用 `--muted`，10px 的百分比读数在 `#fafafa` 上只有 3.98:1——白底浮层里的信息文字不该比卡片正文还轻，于是缩放条与生成参数摘要统一到 `--type-primary`（3.94:1 → 13.19:1，hover 才升到满前景），文本节点空态的三条建议入口同样从 `.5` 提到 `.82`、图标留在 `--muted`。两处刻意停在参考值上：输入框 placeholder `.32`、节点空态描述 `.5`——参考自己就是这么定的，低于 4.5:1 不等于写错。

27. 画布浮层的动作高度改成"由条高派生"，四条浮层只留一种厚度语言：`--canvas-toolbar-action: calc(var(--canvas-toolbar-height) - 6px)` = 40、`--canvas-toolbar-action-compact: calc(var(--canvas-toolbar-height-compact) - 6px)` = 30，减掉的 6px 就是条自己的 2 内边 + 1 描边（上下各 3），和参考 §3.3 的"46 的条配 40 的动作"是同一条算术。写死数字时三处各挑了一个：节点工具条 40 ✅、紧凑变体 30 ✅，而缩放条用 `--control-height` 32——但缩放条描边是 .5，内腔只有 31，动作比腔高 1px，悬停的白色药丸直接贴上圆角描边；现在它是 30×30，实测内腔 31 留 0.5px 余量。分隔线同样统一成 `--toolbar-divider-width: .5px`：节点工具条原来写 1px，缩放条和标注编辑器已经是 .5px，剪辑顶栏那条也是 1px——同一条画布上两种粗细，1px 的线在白底条上像一道污渍。顺带按同一条理由收掉剪辑顶栏的相邻错边（`.ov-actions button` 27 对 `.ov-history button` 26，同一行两条边线不齐，统一到 `--control-height-compact` 28，`padding: 0 13px` 回 `--action-item-padding` 8，品牌标记 23→`--icon-xl` 24），并删掉 `.canvas-zoom-controls`/`.zoom-pct` 这组**没有任何 DOM 消费者**的旧缩放条样式（4 条规则，含两枚颜色 α 字面量）。门禁加到 7 条：新增"浮层动作高度只能取派生档、四条浮层的分隔线必须同厚"，`--subtle button` 那条测试从钉 `height: 30px` 改成钉 `var(--canvas-toolbar-action-compact)`，这样以后有人想调条高只会调一档，不会只调一个条。

28. 生成节点输入行的三样东西定同一档 `--canvas-slot-size: 40px`，并把空行从固定高度的面板里赶出去：§3.4 记的最后一项"近似"到此结清——缩略图、虚线添加位、右侧发送钮原来都借 `--control-height-large`（36），而参考的 file-chip 是 40×40 配 radius md(9.6)，圆角我们已经在 `--radius-md` 上，只差尺寸。这枚 40 和决策 27 的派生动作 40 只是数值相遇：一个是"浮条里的可点动作"，一个是"素材槽位的物理框"，语义不同就分名，谁也不许改完另一个跟着变。换档前先按 40 重算了槽位内部：预览 `width/height: 100%` + `object-fit: cover`、名称角标 inset 3px、移除徽标 16×16 贴在 2px 处，四者都还在盒子内，不需要跟着动。真正的问题是把面板渲染出来才看见的——`.work-composer-inputs` 无论有没有内容都写死 `flex: 0 0 40px`，而纯文本生成节点既没有输入边、也没有可添加的参考槽位，于是这行以**零子元素**的状态在 186px 高的面板里白占一整档，提示词上方凭空一道空白；加 `.work-composer-inputs:empty { display: none; }` 之后实测：文本生成节点该行 `display: none`、高度 0，视频生成节点仍 40px 且带 1 个子元素（添加位），面板高度不变，退回来的 40px 全部给提示词区（textarea 是 `flex: 1 1 auto`）。测试里 6 处 `--control-height-large` 钉点改钉 `--canvas-slot-size`，并新增空行折叠断言，防止有人把空白当成"面板本来就这么高"。

顺带把"档位有没有人用"从口头承诺变成机器判定：写这条时我先用一次自研扫描统计零消费档位，报了 9 枚"死 token"（`--window-shell`、`--shadow-float`、`--layer-toast` 等），差点按 AGENTS.md 的清死代码原则删掉——复核发现扫描漏了 `renderer/styles.css` 这层（只遍历了 `renderer/styles/` 目录和 `src/`），实际 153 枚里唯一无消费者的仍然只有那枚成对行高。结论是：**这种断言不能靠人记，也不能靠一次性脚本**，于是门禁加到 8 条，新增"tokens.css 定义的每一档必须在自有 CSS/TS 里被 `var()` 取用，成对行高除外"。它同时挡住两个方向的漂移：有人新加一档却没人用（假档位，下一次改样式时会被误取），以及有人改消费却把档位定义删了（另一处引用直接哑掉）。

29. 输入面板里"渲染出来只为了让 CSS 藏起来"的东西全部删掉：`.work-type-chip` 长期在 JSX 里无条件渲染 `{metaLabel}`（"视频生成"这类类型名），再由 `.work-composer-row .work-type-chip { display: none }` 整条藏掉——这正是 AGENTS.md 禁止的"默认类型名铺在媒体节点上方"，一个只存在于 DOM 里的违规元素比没有更糟，因为它随时可能被人当"已有 UI"接着用。连着它一起清掉的是同一批画布前身的样式：`work-inputs`、`video-export-trigger`、`work-model-native`、`work-planned-placeholder`、`work-delete-btn`、`node-mention-btn` 六个类**在自有源码里零消费者**（`video-export-trigger` 与 `node-mention-btn` 还各自有一条 `assert.doesNotMatch` 测试钉着它们不许回到 DOM），共约 20 条规则、跨 `canvas.css` 与 `styles.css` 两层删除，同时把 `.work-composer-row :is(.preset-trigger, .video-export-trigger)` 简化回 `.work-composer-row .preset-trigger`。

   这轮真正值得记的是判定方法，因为静态"死类名"扫描天然不可信：先按字面量统计出 113 个候选，其中 **29 个是模板拼出来的活样式**——`route-${route}`、`view-${mediaView}`、`asset-view-${assetView}`、`type-${track.type}`、`is-${status}`、`clip-${clip.type}`、`offset-${item.offset}`、`scope-${file.storageScope}`、`layout-${layout}`，以及 `paramVisualClass()` 返回的 `param-visual-${resolution|duration|style|temperature|length|option}`；按字面删掉任何一个都会直接把对应面板的样式打没。剩下的还要继续排除第三方前缀（`react-flow__*`、`screenshots-*`、`ov-*`、`xy-*`）和 React 过渡类。所以流程固定成三步：字面量查自有源码 → 查模板前缀 → 查第三方/过渡生成，三关都空才算死。剩余候选（`lite-canvas`/`edge-hit`/`minimap-dot`/`project-row*`/`creation-canvas*`/`media-viewer-fade-*` 等约 70 枚）已按同一方法初筛为"仅 CSS"，本轮未动，留待逐个确认没有第三方注入或未来挂载需求后再删。

30. 输入行的让位从"魔法数 160"改成"由触发器真实尺寸派生、且只在触发器在场时成立"：`.work-composer-inputs` 原来无条件写 `width: calc(100% - 160px)`，扣的是右上角浮着的预设触发器——但那个触发器**只有图片生成节点才有**，于是视频/文本节点的缩略图行永远只占 138px，右边挂着一条谁也不用的空列，一屏只能并排 3 个 40px 槽位。现在是 `width: 100%`，配合 `.work-composer:has(.preset-picker) .work-composer-inputs { width: calc(100% - var(--canvas-composer-trigger-reserve)) }`，留位 = `--canvas-preset-trigger-width + 6px`（124）。第一版把面板自己的 10px 右内边距也算进留位（134），实测间隙成了 16px——行本来就在内边距之内，再减内边距就是重复扣；改成 124 后实测间隙正好 6px。渲染几何：无触发器 298（一整行 6 个槽位），有触发器 174（3 个槽位 + 6px 安全距离），移除探针后回到 298，`:has()` 的两条分支都按预期生效。测试同时钉住"不许再出现 `calc(100% - 160px)`"。

31. 字距建成 tokens.css 的第四条阶梯，产品 CSS 里不再有裸 `letter-spacing`：此前只有 `--tracking-tight/-wide` 两档、6 处消费，而自有 CSS 还有 14 处字面量（`0`、`.01`、`-.012`、`-.015`、`-.02`、`.02`、`.03`、`.04`、`.08`、`.13`、`.16em`），等于同一类小标签在设置窗口、画布浮条、剪辑面板、灯箱里各挑了一个数字。档位取自参考实现的 em 阶梯（同一档在不同字号上视觉密度才一致），并按"不定义没有消费者的档位"只留四档：`--tracking-tight -.025em`（13px 以上的标题与品牌名）、`--tracking-normal 0em`（body 与剪辑台作用域的唯一复位值）、`--tracking-wide .025em`（caption 级分组标签）、`--tracking-widest .1em`（全大写/拉丁徽标）。参考上限就是 .1em，所以灯箱的类型徽标 `.16em` 与剪辑检视器的 `h4` `.13em` 是**超出参考的过散写法**，一并回到 `.1em`；两处 `.01em` 与 `-.012em` 落在两档之间没有意义，就近归到复位值或 tight。并排的对照：设置导航标签 `.04em`（0.44px）现在 .025em（0.275px），与对话卡片标签、画布浮条标签同一档；侧栏品牌名 `-.015em` → tight，浏览器实测 14px 下 −0.35px。剪辑台 `.ov-panel-heading small` 原来是 8px 字配 `.08em`，字号已进 `--text-caption-10`，字距再并到 wide，中文微标签不再被拉成疏排。门禁第 9 条：自有 CSS（排除 `/vendor/`）里凡 `letter-spacing` 必须是 `var(--tracking-*)`，tokens.css 内档位必须以 em 结尾、不许写 px。

32. 对话层的图标字形全部落到 `--icon` 档，并显式定出两级层次：在真实渲染页面上按 `getBoundingClientRect` 统计 44 个按钮内字形，尺寸分布是 11/12/13/14/16/18.2（18.2 是画布语义缩放后的 14）——也就是同一张卡片里箭头比图标小一档、菜单图标比头部图标大一档，而这些数字（11、13、15）根本不在 `--icon-xs/sm/md/lg/xl/2xl = 12/14/16/20/24/32` 的梯子上。规则定成两句话：**卡片头部的字形用 `--icon-sm`，行内箭头与状态字形用 `--icon-xs`**。据此把 Composer `.menuIcon`、PlanCard `.headIcon` 从 15 → sm，`.chipChevron` 11 → xs，ToolTrace `.stepIcon`/`.branchIcon` 13 → xs，PlanCard `.stageChevron` 13 → xs（与 step 同一层级），ArtifactList `.headChevron` 13 → sm（与 ToolTrace 头部 chevron 同级，原来两个同名类一个 13 一个 14），并把 `.glyph`、`.menuCheck`、`.headChevron`、`.headIcon` 四处**恰好在档上却是裸数字**的 14/16 也换成令牌，让这一层只有一个来源。刻意不动的三类：`.locate`(24)/`.remove`(16)/`.stop`(16)/`.brand`(16) 是带描边与底色的按钮盒子而不是字形，`--control-height-*` 那一层的 28/32 与 `.canvas-image-crop-handle` 17、开关旋钮 13、指针三角 11×8 属于几何；vendored 3D 导演台整层不参与。门禁第 10 条按选择器扫对话层模块 CSS：`*Icon`、`*Chevron`、`svg` 的 `width/height` 字面量必须落在档位集合内，并钉住两级层次的四条写法。

33. 标注浮层自己裁圆角：图片节点卡片靠 `.work-node`/`.work-preview` 的 `--canvas-node-radius`(10px) + `overflow: hidden` 把图裁成圆角，而 `.canvas-image-annotation-editor` 是挂在屏幕空间的第三方（react-screenshots）浮层，原来只写 `overflow: visible`、图像层没有任何圆角，于是**一进标注模式四个角就变方**（用户红框截图）。修法是把半径还给图像层而不是外层容器：`.screenshots` 与 `.screenshots-canvas` 各加 `overflow: hidden` 与 `border-radius: calc(var(--canvas-node-radius) * var(--canvas-annotation-zoom, 1))`，其中 `--canvas-annotation-zoom` 由组件把已经持有的 `semanticZoom` 写进行内样式——因为浮层的矩形是按 `getBoundingClientRect()` 取的屏幕像素，而卡片的 10px 是被节点内容 `zoom` 缩放后的逻辑值，不乘倍率就会在非 100% 缩放下裁错。外层容器必须保持 `overflow: visible`：操作条浮在图片上方 112px 处，裁容器等于把工具条切掉。测试同时钉住这三件事（半径表达式、zoom 变量注入、容器仍然 visible），防止有人把裁剪"简化"成给容器加 overflow。

**缩放回归（浏览器实测几何，不是截图观感）**：21% / 100% / 130% 三档下名称锚点与卡片 `dx = dw = 0`，名称带底部到卡片顶部的间隙 = `4px × 倍率`（4 → 5.2），名称字号 = `14px × 倍率`（130% 下 18.2px）。无漂移、无第二套尺寸；节点描边按 `1px / 倍率` 写逻辑值，屏幕厚度不随倍率变化。

**仍未落地（按肉眼影响排序）**

- 抬升本轮已经收口（阴影 α 字面量 0 处、`--slk-elevation-*` 改借产品档位），剩下的 183 处 α 全是**颜色**：hover wash、选中 wash、素材上的白墨填充、剪辑覆盖层的黑 α 面板。要不要把它们也并成 wash 档位（已有 `--popup-item-hover/-active`、`--canvas-controls-hover`、`--*-wash`、`--overlay-ink-muted/-hint`）是产品决定；再往下压就是把 `rgba(0,0,0,.06)` 这类一次性 wash 换成 `--canvas-selection-bg`，但那是别处语义的复用，容易把"恰好同为 6% 黑"当成"同一件事"。
- 剪辑时间轴与画布卡片已经共用 `--shadow-card/-lift`，静止态比原来更实（`.02 → .05`）；观感是否比"几乎无影 + 描边"更耐看，要在真实 Tauri 窗口里判。
- `.ov-editor` 里 13 处 hex 是一份有意保留的本地调色板：时间线片段按轨道类型分色属于轨道信息本身（描边 / 文字 / 底三档成对声明）。要不要并入 tokens.css 同样是产品决定。
- 契约门禁只扫自有 CSS：TSX 行内样式与第三方注入不在覆盖范围内，保留的 `color="#171717"`（NodeResizer）、logo 填充、字幕默认色是真实组件 API 值或用户可编辑素材数据，不是界面 chrome。
- webkit 滚动条三态、富文本工具条、灯箱墨阶、模态框抬升与缩略图深色镜像的最终观感只能在真实 Tauri 窗口里判定；自动化视口 584×655 只能证明几何与计算样式，证明不了整体观感。
- `!important` 自有 33 处已逐条核实：第三方标注编辑器覆盖与 React Flow handle 的行内样式压制，属于必须保留的优先级，不是未清理的残留。

