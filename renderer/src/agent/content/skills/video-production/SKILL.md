---
name: 全流程影像制作
description: 负责把视频制作需求路由到合适的内容 Skill，组织真实画布计划，并按依赖推进执行；适合短片、MV、预告和品牌影像。
---

# 全流程影像制作

这是视频制作的编排 Skill，不承载所有写作、视觉设计、音频设计和模型参数细节。先识别输入成熟度与用户要交付的层级，再调用对应的专项 Skill 产出内容；本 Skill 只负责选择顺序、建立依赖、写入画布和核验结果。

## 编排流程

1. 判断当前输入是主题、小说/长篇、梗概、剧本、分镜、参考素材还是已有成片，并确认用户要分析、规划、生成还是完整执行。
2. 只补下一项必要工作：不把小说直接当分镜，不重做已有剧本或镜头表，也不因为流程完整而创建无用文档。
3. 在内部归并跨镜视觉实体和别名，标记身份、空间、动作、构图、声音和模型能力风险；这只是路由依据，不额外创建分析节点。
4. 为每个确定的交付物选择一个专项 Skill 或 Recipe。专项内容由对应 Skill 负责，本 Skill 不复制它的提示词模板。
5. `plan_canvas` 必须把已经确定的媒体交付物落成真实节点、输入边和完整配置；文字说明不能代替节点。
6. `plan_and_execute` 按依赖阶段启动节点，等待真实输出成功后再继续下游；视频输入的内部适配由运行时完成，不创建预处理节点。
7. 完成前检查真实节点、任务、文件和回执，报告缺失输入、降级交付或未执行内容。

## 专项 Skill 路由

- 原作、梗概和剧本：`narrative-source-analysis`、`screenplay-adaptation`、`short-drama`、`script-to-video`
- 创意和镜头设计：`video-creative-outline`、`video-storyboard-script`、`video-shot-storyboard`、`video-action-sequence-board`、`video-storyboard-grid`
- 角色、场景和道具：`character-board`、`video-character-design`、`video-character-turnaround`、`script-element-reference`
- 关键帧与连续视频：`video-frame-extraction`、`video-clip-generation`、`keyframe-video`
- 配音、音乐和拟音：`video-audio-design`、`video-audio-production-sheet`

专项 Skill 未覆盖时，直接编写满足当前模型能力和交付规格的提示词，不因缺少模板而阻塞计划。

## 画布与执行边界

- 每个已经确定的连续镜头对应真实视频节点；身份、空间、动作和关键帧只有在当前镜头确实需要时才建立上游节点。
- 输入边的媒体类型、业务槽位和节点 `inputMode` 必须使用统一契约；不要用连线顺序、素材数量或 UI 文案猜测语义。
- `canvas_layout_nodes` 只整理真实节点和拓扑，不推断故事顺序；不得创建代码中不存在的时间线、合成器或汇总节点。
- 只有生产范围为 `plan_and_execute` 且用户设置允许时，才调用 `canvas_start_generation`。
- 任务失败时根据真实回执修复具体问题；不能靠重复调用或堆叠无关参考掩盖失败。

## 交付核验

完成前确认：依赖无环、节点配置完整、prompt 非空、输入职责可解释、生成任务和输出文件真实存在，且没有把独立生成描述成提取结果。专项 Skill 负责内容质量，本 Skill 负责流程完整性和事实核验。
