import assert from 'node:assert/strict';
import test from 'node:test';
import { readGenerationNodeSource } from './helpers/generationNodeSource.mjs';
import { readSource } from './helpers/sourceContract.mjs';

const toolbar = readSource('renderer/src/app/canvas/CanvasNodeToolbar.tsx');
const workflowCanvas = readSource('renderer/src/app/canvas/WorkflowCanvas.tsx');
const canvas = toolbar + workflowCanvas;
const cropEditor = readSource('renderer/src/app/components/ImageCropEditor.tsx');
const annotationEditor = readSource('renderer/src/app/components/ImageAnnotationEditor.tsx');
const generation = readGenerationNodeSource();
const basicNodes = readSource('renderer/src/app/canvas/CanvasNodes.tsx');
const director = readSource('renderer/src/app/canvas/ThreeDDirectorNode.tsx');
const styles = ['canvas.css', 'media-overlays.css']
  .map((name) => readSource(`../renderer/styles/${name}`))
  .join('\n');
const adapter = readSource('renderer/src/app/adapters/canvasAdapter.ts')
  + readSource('renderer/src/app/adapters/canvas/canvasMediaActions.ts');
const api = readSource('renderer/src/services/tauriApi.ts');
const audioRust = readSource('src-tauri/src/commands/audio.rs');
const fileRust = readSource('src-tauri/src/commands/file.rs');
const imageRust = readSource('src-tauri/src/commands/image.rs');
const nodeChrome = await import('../renderer/src/utils/canvasNodeChrome.ts');

test('画布节点外框与选中操作工具栏保持职责分离', () => {
  assert.match(workflowCanvas, /import \{ CanvasNodeToolbar \}/);
  assert.match(workflowCanvas, /<CanvasNodeToolbar[\s\S]*?canvasOverlayRoot=\{canvasOverlayRoot\}/);
  assert.doesNotMatch(workflowCanvas, /desktopApi\.file\.hasAudio|assetScopeMenuOpen|<ImageCropEditor/);
  assert.match(toolbar, /desktopApi\.file\.hasAudio/);
  assert.match(toolbar, /assetScopeMenuOpen/);
  assert.match(toolbar, /onImageCropOpen/);
});

test('加入对话只在节点选中工具栏中显示', () => {
  assert.match(canvas, /<NodeToolbar[\s\S]*?canvas-node-selection-toolbar--hidden[\s\S]*?isVisible=\{selected && !imageAnnotationOpen\}[\s\S]*?offset=\{toolbarOffset\}[\s\S]*?>[\s\S]*?加入对话[\s\S]*?<\/NodeToolbar>/);
  assert.match(canvas, /mentionNode\(node\.id\)/);
  // 3D 导演台节点不挂引用入口，工具栏整体不渲染，而不是留下一个空壳。
  assert.match(toolbar, /node\.type === "threeDDirector" \? null : addNodeMention/);
  assert.match(toolbar, /hasToolbar = isTextNode \|\| canUpload \|\| mentionNode \|\|/);
  assert.match(styles, /\.canvas-node-selection-toolbar \{[\s\S]*?z-index: var\(--layer-canvas-control\)/);
  for (const source of [generation, basicNodes, director]) {
    assert.doesNotMatch(source, /className="node-mention-btn/);
  }
});

test('画布不存在便签与画板节点', () => {
  const navigation = readSource('renderer/src/app/constants/navigation.ts');
  const nodeTypes = readSource('renderer/src/services/agentTypes.ts');
  const registry = readSource('renderer/src/app/canvas/nodeRegistry.ts');
  const graphIr = readSource('renderer/src/domain/graph/GraphIR.ts');
  assert.doesNotMatch(nodeTypes, /'note'|'board'/);
  assert.doesNotMatch(graphIr, /boardText|boardData/);
  for (const source of [navigation, registry, workflowCanvas, styles]) {
    assert.doesNotMatch(source, /\bnote\b|\bboard\b/);
  }
});

test('文本节点工具栏提供复制、加入对话与完整文本编辑', () => {
  assert.match(canvas, /isTextNode = node\.type === "textGeneration"/);
  assert.match(canvas, /canvas-node-toolbar-label">文本节点/);
  assert.match(canvas, /title="复制全文"[\s\S]*?navigator\.clipboard\.writeText\(textContent\)/);
  assert.match(canvas, /title="打开完整文本"[\s\S]*?openTextDetail\(\)/);
  assert.match(canvas, /openMediaViewer\(\{[\s\S]*?kind: "text"[\s\S]*?actions\.update\(node\.id/);
  assert.doesNotMatch(canvas, /item\.textContent \|\| item\.prompt/);
});

test('媒体节点工具栏提供真实入库与音频分离', () => {
  assert.match(canvas, /canExtractAudio[\s\S]*?actions\.extractAudio\(node\.id\)[\s\S]*?音频分离/);
  assert.match(canvas, /desktopApi\.file\.hasAudio\(localMediaPath\)[\s\S]*?"present"\s*:\s*"absent"/);
  assert.match(canvas, /disabled=\{!canExtractAudio \|\| audioSplitRunning\}[\s\S]*?"拆分中…"[\s\S]*?"无音轨"/);
  assert.match(canvas, /canSaveToAssets[\s\S]*?存为资产[\s\S]*?assetScopeMenuOpen/);
  assert.match(canvas, /assetCategories\.map[\s\S]*?setAssetCategory\(category\.id\)/);
  assert.match(canvas, /createPortal\([\s\S]*?canvas-node-asset-scope-menu--portal[\s\S]*?canvasOverlayRoot/);
  assert.match(canvas, /assetPlacementRevision = useStore[\s\S]*?positionAbsolute[\s\S]*?state\.transform/);
  assert.match(canvas, /actions\.saveToAssets\(node\.id, "project", assetCategory\)[\s\S]*?<strong>存到项目<\/strong>/);
  assert.match(canvas, /actions\.saveToAssets\(node\.id, "global", assetCategory\)[\s\S]*?<strong>存到全局<\/strong>/);
  assert.match(adapter, /async function saveToAssets\([\s\S]*?scope === "project"[\s\S]*?addMaterialToAssetLibrary[\s\S]*?promoteMaterialToLocalLibrary/);
  assert.match(adapter, /assetDetails = \{[\s\S]*?category,[\s\S]*?promoteMaterialToLocalLibrary/);
  assert.match(adapter, /scope === "project"[\s\S]*?ensureMaterialStoredInProjectAssets\(projectMaterial\)[\s\S]*?addMaterialToAssetLibrary/);
  assert.match(styles, /\.canvas-node-asset-scope-menu \{[\s\S]*?width:\s*220px/);
  assert.match(styles, /\.canvas-node-asset-scope-menu--portal \{[\s\S]*?z-index:\s*calc\(var\(--layer-canvas-composer\) \+ 1\)/);
  assert.match(styles, /\.react-workflow-canvas \{[\s\S]*?isolation:\s*isolate/);
  assert.match(adapter, /async function extractAudio\(id: string\)[\s\S]*?separateAudioToProject[\s\S]*?addNode\("videoGeneration"\)[\s\S]*?addNode\("audioGeneration"\)/);
  assert.match(adapter, /sourceDimensions = canvasNodeDimensions\(source\)[\s\S]*?silentVideo\.y \+ canvasNodeDimensions\(silentVideo\)\.height \+ 48/);
  assert.match(adapter, /addCanvasEdge\(store\.project, source\.id, silentVideo\.id[\s\S]*?addCanvasEdge\(store\.project, source\.id, audio\.id/);
  assert.match(api, /separateAudioToProject:[\s\S]*?file:separate-audio/);
  assert.match(api, /hasAudio:[\s\S]*?file:has-audio/);
  assert.match(audioRust, /fn probe_audio[\s\S]*?source_has_audio/);
  assert.match(audioRust, /pub async fn file_has_audio[\s\S]*?spawn_blocking/);
  assert.match(audioRust, /pub async fn file_separate_audio[\s\S]*?spawn_blocking/);
  assert.match(audioRust, /fn separate_audio[\s\S]*?source_has_audio[\s\S]*?"-map", "0:a:0"[\s\S]*?"-c:a", "aac"[\s\S]*?"-map", "0:v:0"[\s\S]*?"-an"[\s\S]*?"copy"/);
});

test('本地图片节点提供原图裁剪并创建保留来源连线的新节点', () => {
  assert.match(toolbar, /isLocalImage[^]*?title="在画布上裁剪图片"[^]*?onImageCropOpen\(\)/);
  assert.match(workflowCanvas, /imageCropOpen=\{imageCropOpen\}[^]*?onImageCropOpen/);
  assert.match(generation, /<ImageCropEditor[^]*?actions\.cropImage\(node\.id, rect\)/);
  assert.match(cropEditor, /createPortal\([^]*?canvas-image-crop-toolbar[^]*?, root\)/);
  assert.match(cropEditor, /ratios[\s\S]*?"1:1"[\s\S]*?"16:9"[\s\S]*?"9:16"/);
  assert.match(adapter, /async function cropImage\(id: string, crop: ImageCropRect\)[\s\S]*?cropImageToProject[\s\S]*?addNode\("imageGeneration"\)/);
  assert.match(adapter, /addCanvasEdge\(store\.project, source\.id, output\.id[\s\S]*?derivation: "image-crop"/);
  assert.match(api, /case 'file:crop-image':[\s\S]*?file_crop_image/);
  assert.match(api, /cropImageToProject:[\s\S]*?file:crop-image/);
  assert.match(imageRust, /pub async fn file_crop_image[\s\S]*?spawn_blocking/);
  assert.match(imageRust, /fn crop_image[\s\S]*?apply_orientation[\s\S]*?crop_imm[\s\S]*?ImageFormat::Png/);
  assert.match(styles, /\.canvas-image-crop-layer \{/);
  assert.match(styles, /\.canvas-image-crop-toolbar \{[^}]*z-index:\s*var\(--layer-canvas-composer\)/);
});

test('本地图片节点使用 react-screenshots 完成标注并保存合成图片', () => {
  assert.match(toolbar, /title="标注图片"[\s\S]*?onImageAnnotationOpen\(\)/);
  assert.match(workflowCanvas, /imageAnnotationOpen=\{imageAnnotationOpen\}[\s\S]*?onImageAnnotationOpen/);
  assert.match(generation, /ImageAnnotationEditor[\s\S]*?imageUrl=\{previewUrl\}[\s\S]*?saveDataUrlToProject/);
  assert.match(annotationEditor, /react-screenshots\/lib\/Screenshots\/ScreenshotsCanvas/);
  assert.match(annotationEditor, /operation_text_title: "标注"/);
  assert.match(annotationEditor, /operation_mosaic_title: "马赛克"/);
  assert.match(generation, /saveDataUrlToProject/);
  assert.match(generation, /annotationImagePath/);
  assert.match(styles, /\.canvas-image-annotation-editor \.screenshots \{/);
  // 标注浮层必须自己裁圆角：卡片靠 --canvas-node-radius 裁图，浮层不裁就在四个角露出方角画布。
  assert.match(styles, /\.canvas-image-annotation-editor \.screenshots,\s*\n\.canvas-image-annotation-editor \.screenshots-canvas \{ border-radius: calc\(var\(--canvas-node-radius\) \* var\(--canvas-annotation-zoom, 1\)\); \}/);
  assert.match(annotationEditor, /"--canvas-annotation-zoom": String\(semanticZoom\)/);
  // 只裁图像层，外层容器仍要 visible，否则操作条浮不到图片之外。
  assert.match(styles, /\.canvas-image-annotation-editor \{\n(?:[^}\n]*\n)*?  overflow: visible;/);
  assert.match(annotationEditor, /ScreenshotsContext\.Provider/);
  // 图标档位与节点选中工具栏同一档（--icon-md）：第三方图标字体按 em 刻字，缩到这一档才不比产品线性图标粗。
  assert.match(styles, /\.canvas-node-selection-toolbar svg \{ width: var\(--icon-md\); height: var\(--icon-md\); \}/);
  assert.match(styles, /\.canvas-image-annotation-editor \.screenshots-button \{\n(?:[^}\n]*\n)*?  font-size: var\(--icon-md\);\n/);
  assert.match(styles, /\.canvas-image-annotation-editor \.screenshots-button > span \{\n  line-height: 1;\n\}/);
  // 分隔线由本项目给出：第三方自带的样式是 26px 实色粗线，会在细图标之间形成更重的块。
  assert.match(styles, /\.canvas-image-annotation-editor \.screenshots-operations-divider \{\n  width: var\(--toolbar-divider-width\);/);
});

// 标注的第二条出路：把合成结果另存成新素材并派生一个节点，原节点一个字段都不动。
test('标注可以派生新的图片节点而不改动原节点', () => {
  // 操作条由本项目拼接，否则第三方那份固定的按钮清单里放不下"生成新节点"。
  assert.match(annotationEditor, /import annotationOperations from "\.\.\/\.\.\/\.\.\/\.\.\/node_modules\/react-screenshots\/lib\/Screenshots\/operations\/index\.js"/);
  assert.match(annotationEditor, /annotationOperations\.map/);
  assert.match(annotationEditor, /title="标注完成，生成新节点"/);
  assert.match(annotationEditor, /compose\(onCreateNode\)/);
  // 合成必须和"完成"走同一条路：先摘掉选中态，否则蓝色选择框会被画进结果图。
  assert.match(annotationEditor, /HistoryItemType\.Source\) item\.isSelected = false/);
  assert.match(annotationEditor, /composeImage\(\{ image, width, height, history, bounds \}\)/);
  assert.match(generation, /if \(await actions\.createAnnotationNode\(node\.id, blob\)\) onImageAnnotationClose\?\.\(\)/);

  const annotationAction = adapter.slice(
    adapter.indexOf('export async function createAnnotationNode'),
    adapter.indexOf('export async function splitImageGrid'),
  );
  assert.ok(annotationAction.length > 0, '缺少 createAnnotationNode 实现');
  assert.doesNotMatch(annotationAction, /annotationImageUrl|annotationData|Object\.assign\(/);
  assert.match(annotationAction, /recordCanvasHistory\([\s\S]*?addNode\("imageGeneration"\)/);
  assert.match(annotationAction, /output\.uploadedFile = \{[\s\S]*?filePath,[\s\S]*?mimeType: "image\/png"/);
  assert.match(annotationAction, /derivation: "image-annotation"/);
  assert.match(styles, /\.canvas-image-annotation-editor \.canvas-annotation-node-button svg \{\s*\n\s*width: var\(--icon-md\);/);
});

test('空媒体节点从顶部工具栏上传且节点内部只保留占位图标', () => {
  assert.match(canvas, /const canUpload = Boolean\(uploadLabel && !hasMediaContent\)/);
  assert.match(canvas, /toolbarOffset = canvasNodeToolbarOffset\(semanticZoom, useSubtleUploadToolbar\)/);
  assert.match(canvas, /useSubtleUploadToolbar[\s\S]*?canvas-node-selection-toolbar--subtle[\s\S]*?offset=\{toolbarOffset\}/);
  assert.match(canvas, /\{canUpload && \([\s\S]*?title=\{`上传\$\{uploadLabel\}`\}[\s\S]*?actions\.upload\(node\.id\)/);
  assert.doesNotMatch(generation, /className="work-empty-upload/);
  assert.doesNotMatch(generation, /上传\{metaLabel\.replace/);
  assert.match(styles, /--canvas-node-state-icon-size:\s*34px/);
  assert.match(styles, /\.work-preview \.work-empty-type-icon \{[^}]*width:\s*var\(--canvas-node-state-icon-size\)[^}]*height:\s*var\(--canvas-node-state-icon-size\)/);
  assert.match(styles, /\.canvas-node-selection-toolbar--subtle \{[\s\S]*?background:\s*transparent;[\s\S]*?box-shadow:\s*none/);
  assert.match(styles, /\.canvas-node-selection-toolbar--subtle button \{[\s\S]*?height:\s*var\(--canvas-toolbar-action-compact\);[\s\S]*?font-size:\s*var\(--text-body-12\)/);
});

test('节点顶部工具栏保持屏幕字号并随名称高度避让', () => {
  assert.equal(nodeChrome.canvasNodeToolbarOffset(0.55, true), 26);
  assert.equal(nodeChrome.canvasNodeToolbarOffset(1, true), 34);
  assert.equal(nodeChrome.canvasNodeToolbarOffset(1.8, true), 56.4);
  assert.equal(nodeChrome.canvasNodeToolbarOffset(0.55, false), 38);
  assert.equal(nodeChrome.canvasNodeToolbarOffset(1, false), 38);
  assert.equal(nodeChrome.canvasNodeToolbarOffset(1.8, false), 60.4);
  assert.match(canvas, /top: -CANVAS_NODE_LABEL_OFFSET \* semanticZoom/);
  assert.match(canvas, /height: CANVAS_NODE_LABEL_HEIGHT \* semanticZoom/);
  assert.match(styles, /\.canvas-node-selection-toolbar--subtle button \{[^}]*font-size:\s*var\(--text-body-12\)/);
  assert.doesNotMatch(styles, /canvas-node-selection-toolbar[^}]*transform:\s*scale/);
});
