import { coerceParamValue, getGenerationInputModes, getModelInputCapabilityForRoles, getModelSchema, isModelForType, resolveModeIdForInputMode, resolveModelRuntimeContract } from '@/domain/catalog/ModelCatalog';
import type { CatalogInputConstraints, ModelRuntimeContract } from '@/domain/catalog/ModelCatalog';
import type { GenerationInputModeDescriptor, GenerationInputMode, GenerationInputSlot } from '@/domain/graph/GenerationInputContract';
import { applyCameraConfigToPrompt, normalizeCameraConfig } from '@/utils/cameraConfig';
import { extractGeneratedFiles } from '@/utils/generatedOutputParsing.ts';
import { applyImageStylePreset } from '@/utils/imageStylePresets.ts';
import { normalizeInputRole } from '@/utils/generationInputRole.ts';
import { compileGenerationNodeConfig } from '@/domain/graph/GenerationNodeContract';
import { inputSlotOrder, isSlotValidForMode } from '@/domain/graph/GenerationInputContract';
import { textNodeContent } from '@/utils/textNodeContent.ts';

// 节点、任务与素材记录来自尚未类型化的 store/JS 调用方，这里按本文件真实读取的字段建模；
// 可选字段一律显式允许 undefined，避免为了通过检查而使用 any 或非空断言。
export interface UploadedFilePayload {
  name: string;
  path: string;
  url: string;
  type: string;
  size: number;
  materialId: string;
  resourceType: string;
}

interface UploadedFileLike {
  name?: string | undefined;
  path?: string | undefined;
  filePath?: string | undefined;
  url?: string | undefined;
  type?: string | undefined;
  size?: number | undefined;
  materialId?: string | undefined;
  resourceType?: string | undefined;
  duration?: number | undefined;
}

interface ImageEditLike {
  mode?: string | undefined;
  sourceFile?: string | undefined;
  maskFile?: string | undefined;
  regions?: unknown;
}

interface GenerationNodeConfig {
  inputStrategy?: string | undefined;
  cameraControl?: boolean | undefined;
  cameraConfig?: Record<string, unknown> | undefined;
  stylePresetId?: string | undefined;
  [key: string]: unknown;
}

export interface CanvasNode {
  id?: string;
  type?: string;
  title?: string;
  model?: string;
  prompt?: string;
  config?: GenerationNodeConfig | undefined;
  outputSpec?: unknown;
  uploadedFile?: UploadedFileLike | undefined;
  inputMode?: GenerationInputMode | string | undefined;
  imageEdit?: ImageEditLike | undefined;
  status?: string | undefined;
  archived?: boolean | undefined;
  selectedOutputNodeId?: string | undefined;
  directorData?: unknown;
  // 资源节点（type === 'resource'）字段
  content?: string | undefined;
  resourceType?: string | undefined;
  fileName?: string | undefined;
  filePath?: string | undefined;
  url?: string | undefined;
  previewUrl?: string | undefined;
  remoteUrl?: string | undefined;
  resourceUrl?: string | undefined;
  objectKey?: string | undefined;
  materialId?: string | undefined;
  mimeType?: string | undefined;
  size?: number | undefined;
  duration?: number | undefined;
  [key: string]: unknown;
}

interface CanvasEdge {
  id?: string;
  source?: string;
  target?: string;
  data?: Record<string, unknown> | undefined;
}

interface TaskResultLike {
  output?: unknown;
  raw?: unknown;
  archivedFiles?: MaterialRecord[];
  [key: string]: unknown;
}

interface TaskRecord {
  id?: string;
  nodeId?: string;
  createdAt?: string | number | undefined;
  startedAt?: string | undefined;
  completedAt?: string | undefined;
  result?: TaskResultLike | undefined;
  [key: string]: unknown;
}

interface MaterialRecord {
  id?: string;
  nodeId?: string;
  name?: string;
  path?: string;
  filePath?: string;
  url?: string;
  resourceUrl?: string;
  previewUrl?: string;
  remoteUrl?: string;
  objectKey?: string;
  materialId?: string;
  resourceType?: string;
  mimeType?: string;
  size?: number | undefined;
  duration?: number | undefined;
  source?: string;
  importedAt?: string | number | undefined;
  [key: string]: unknown;
}

export interface CanvasProject {
  edges?: CanvasEdge[];
  nodes?: CanvasNode[];
  tasks?: TaskRecord[];
  materials?: MaterialRecord[];
  [key: string]: unknown;
}

type InputResource = {
  nodeId?: string | undefined;
  title?: string | undefined;
  resourceType?: string | undefined;
  fileName?: string | undefined;
  filePath?: string | undefined;
  url?: string | undefined;
  previewUrl?: string | undefined;
  remoteUrl?: string | undefined;
  objectKey?: string | undefined;
  materialId?: string | undefined;
  mimeType?: string | undefined;
  size?: number | undefined;
  duration?: number | undefined;
  inputRole?: string | undefined;
  inputSlot?: string | undefined;
  required?: boolean | undefined;
};

// 候选资源与已解析输入在整条管道里只被读取，字段缺失都按空值处理。
type ModelInputResource = Partial<InputResource> & {
  selectedOutput?: SelectedOutputSummary | null;
  uploadedFile?: UploadedFilePayload | null;
};

interface SelectedOutputSummary extends Partial<InputResource> {
  content?: string;
}

interface ResourceSummary extends SelectedOutputSummary {
  nodeId: string;
}

export interface UpstreamInput {
  edgeId: string;
  inputRole: string;
  inputSlot: GenerationInputSlot;
  required: boolean;
  nodeId: string;
  nodeType: string;
  title: string;
  prompt: string;
  status: string;
  // 资源节点
  resourceType?: string | undefined;
  fileName?: string | undefined;
  filePath?: string | undefined;
  url?: string | undefined;
  previewUrl?: string | undefined;
  remoteUrl?: string | undefined;
  objectKey?: string | undefined;
  materialId?: string | undefined;
  mimeType?: string | undefined;
  size?: number | undefined;
  duration?: number | undefined;
  // 3D 导演台
  directorData?: unknown;
  // 生成节点
  model?: string | undefined;
  uploadedFile?: UploadedFilePayload | null;
  taskId?: string | undefined;
  result?: TaskResultLike | undefined;
  selectedOutputNodeId?: string | undefined;
  selectedOutput?: SelectedOutputSummary | null;
}

interface GenerationInputs {
  images: ModelInputResource[];
  videos: ModelInputResource[];
  audios: ModelInputResource[];
}

export interface GenerationPayload {
  nodeId?: string | undefined;
  nodeType?: string | undefined;
  model: string;
  prompt: string;
  uploadedFile: UploadedFilePayload | null;
  inputs: UpstreamInput[];
  modelContract: ModelRuntimeContract | null;
  modelInputs: GenerationInputs;
  upstreamContext: string;
  [key: string]: unknown;
}

export interface GenerationReadiness {
  ready: boolean;
  issues: string[];
  inputs?: UpstreamInput[];
}

const INPUT_SOURCE_TYPES = ['imageGeneration', 'videoGeneration', 'audioGeneration', 'textGeneration', 'resource', 'threeDDirector'];
const GENERATION_SOURCE_TYPES = ['imageGeneration', 'videoGeneration', 'audioGeneration', 'textGeneration'];

function pickString(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

// 槽位来自未类型化的画布边数据，只有在这一处边界做断言归一化。
function toSlot(value: unknown): GenerationInputSlot {
  return String(value || '') as GenerationInputSlot;
}

function schemaParamsPayload(type: string | undefined, config: GenerationNodeConfig = {}, model = '', modeId = ''): Record<string, unknown> {
  return Object.fromEntries(
    (getModelSchema(type, model, modeId).params || [])
      .filter((param) => param?.key && param.key !== 'prompt' && param.key !== 'model')
      .map((param) => {
        const coerced = coerceParamValue(param, config[param.key] ?? param.default);
        const allowed = (param.options || []).map((option) => (
          option && typeof option === 'object' ? (option as { value?: unknown }).value : option
        ));
        return [param.key, allowed.length && !allowed.includes(coerced) ? param.default : coerced];
      }),
  );
}

function basePayload(node: CanvasNode, config: GenerationNodeConfig, project: CanvasProject | null | undefined): GenerationPayload {
  const inputs = collectUpstreamInputs(node, project);
  const model = pickString(node.model, 'gpt-image-2');
  const inputRoles = [
    ...inputs.map(effectiveInputRole),
    ...(node.imageEdit?.sourceFile ? ['image'] : []),
  ];
  const hasMediaInputs = inputRoles.some((role) => !['', 'auto', 'textContext'].includes(role));
  // Explicit mode is honored only when it supports the actual typed inputs.
  // Otherwise choose the compatible model mode deterministically.
  const modelContract = resolveModelRuntimeContract(
    node.type,
    model,
    inputRoles,
    hasMediaInputs ? resolveModeIdForInputMode(model, node.inputMode) : '',
  );
  const upstreamContext = inputs
    .filter((input) => input.inputRole === 'textContext'
      || (input.inputRole === 'auto' && input.nodeType === 'textGeneration'))
    .map((input) => `[${input.title}] ${input.prompt}`)
    .filter(Boolean)
    .join('\n');
  const modelInputs = collectModelInputs({
    inputs,
    uploadedFile: uploadedFilePayload(node.uploadedFile),
    capability: modelContract,
    inputStrategy: config.inputStrategy || 'auto',
  });
  const ownPrompt = pickString(node.prompt);
  return {
    nodeId: node.id,
    nodeType: node.type,
    model,
    prompt: node.type !== 'textGeneration' && upstreamContext
      ? `${ownPrompt}\n\n必须继承的上游文本约束：\n${upstreamContext}`
      : ownPrompt,
    uploadedFile: uploadedFilePayload(node.uploadedFile),
    inputs,
    modelContract,
    modelInputs,
    upstreamContext,
  };
}

function uploadedFilePayload(file: UploadedFileLike | null | undefined): UploadedFilePayload | null {
  if (!file) return null;
  return {
    name: pickString(file.name),
    path: pickString(file.path || file.filePath),
    url: pickString(file.url),
    type: pickString(file.type),
    size: file.size || 0,
    materialId: pickString(file.materialId),
    resourceType: pickString(file.resourceType),
  };
}

export function buildGenerationPayload(node: CanvasNode, project: CanvasProject | null | undefined): GenerationPayload {
  const sourceConfig: GenerationNodeConfig = { ...(node.config || {}) };
  const payload = basePayload(node, sourceConfig, project);
  const schema = getModelSchema(node.type, payload.model, payload.modelContract?.modeId || '');
  const config = compileGenerationNodeConfig(sourceConfig, schema.params, node.outputSpec) as GenerationNodeConfig;
  const schemaParams = schemaParamsPayload(node.type, config, payload.model, payload.modelContract?.modeId || '');

  if (node.type === 'imageGeneration') {
    const cameraControl = Boolean(config.cameraControl && config.cameraConfig);
    const cameraConfig = cameraControl ? normalizeCameraConfig(config.cameraConfig) : null;
    const imageEdit = payload.modelContract?.supportsMaskEditing      && node.imageEdit?.mode && node.imageEdit?.maskFile && node.imageEdit?.sourceFile
      ? {
          mode: node.imageEdit.mode,
          regions: Array.isArray(node.imageEdit.regions) ? node.imageEdit.regions : [],
          sourceFile: node.imageEdit.sourceFile,
          maskFile: node.imageEdit.maskFile,
        }
      : null;
    const styledPrompt = applyImageStylePreset(payload.prompt, config.stylePresetId);
    return {
      ...payload,
      prompt: cameraControl ? applyCameraConfigToPrompt(styledPrompt, cameraConfig) : styledPrompt,
      ...schemaParams,
      cameraControl,
      cameraConfig,
      imageEdit,
    };
  }

  if (node.type === 'videoGeneration') {
    return {
      ...payload,
      ...schemaParams,
      inputStrategy: config.inputStrategy || 'auto',
    };
  }

  if (node.type === 'audioGeneration') {
    return {
      ...payload,
      ...schemaParams,
    };
  }

  if (node.type === 'textGeneration') {
    return {
      ...payload,
      ...schemaParams,
    };
  }

  return payload;
}

function collectUpstreamInputs(node: CanvasNode, project: CanvasProject | null | undefined): UpstreamInput[] {
  if (!project || !Array.isArray(project.edges) || !Array.isArray(project.nodes)) return [];
  const edges = project.edges;
  const nodes = project.nodes;
  const linked: Array<{ edge: CanvasEdge; source: CanvasNode }> = [];
  for (const edge of edges) {
    if (edge.target !== node.id) continue;
    if (edge.data?.skipTaskInput === true) continue;
    const source = nodes.find((item) => item.id === edge.source);
    if (!source || source.archived) continue;
    if (!INPUT_SOURCE_TYPES.includes(String(source.type))) continue;
    linked.push({ edge, source });
  }
  return linked
    .map(({ edge, source }): UpstreamInput => {
      const inputMeta = {
        edgeId: edge.id || '',
        inputRole: normalizeInputRole(edge.data?.inputRole || 'auto'),
        inputSlot: toSlot(edge.data?.inputSlot),
        required: edge.data?.required !== false,
      };
      const latestTask = latestTaskForNode(project, source.id);
      if (source.type === 'resource') {
        return {
          ...inputMeta,
          nodeId: source.id || '',
          nodeType: source.type,
          title: pickString(source.title || source.fileName, '资源'),
          prompt: pickString(source.content || source.filePath || source.url || source.previewUrl),
          status: source.status || 'completed',
          resourceType: source.resourceType || '',
          fileName: source.fileName || '',
          filePath: source.filePath || '',
          url: source.url || source.resourceUrl || '',
          previewUrl: source.previewUrl || '',
          remoteUrl: source.remoteUrl || '',
          objectKey: source.objectKey || '',
          materialId: source.materialId || '',
          mimeType: source.mimeType || '',
          size: source.size || 0,
          duration: source.duration || 0,
        };
      }
      if (source.type === 'threeDDirector') {
        return {
          ...inputMeta,
          nodeId: source.id || '',
          nodeType: source.type,
          title: pickString(source.title, '3D导演台'),
          prompt: '',
          status: 'completed',
          directorData: source.directorData || null,
        };
      }
      return {
        ...inputMeta,
        nodeId: source.id || '',
        nodeType: source.type || '',
        title: pickString(source.title, source.type),
        prompt: pickString(source.type === 'textGeneration' ? textNodeContent(source) : source.prompt),
        model: pickString(source.model),
        status: source.status || 'idle',
        uploadedFile: uploadedFilePayload(source.uploadedFile),
        taskId: latestTask?.id,
        result: latestTask?.result,
        selectedOutputNodeId: source.selectedOutputNodeId || '',
        selectedOutput: selectedOutputSummary(project, source),
      };
    })
    .sort((a, b) => inputSlotOrder(a.inputSlot) - inputSlotOrder(b.inputSlot));
}

function latestTaskForNode(project: CanvasProject | null | undefined, nodeId: string | undefined): TaskRecord | null {
  return [...(project?.tasks || [])]
    .filter((task) => task.nodeId === nodeId)
    .sort((a, b) => {
      const aTime = Date.parse(a.completedAt || a.startedAt || String(a.createdAt || 0)) || 0;
      const bTime = Date.parse(b.completedAt || b.startedAt || String(b.createdAt || 0)) || 0;
      return bTime - aTime;
    })[0] || null;
}

function selectedOutputSummary(project: CanvasProject | null | undefined, source: CanvasNode | null | undefined): SelectedOutputSummary | null {
  if (!project || !source) return null;
  const selectedId = source.selectedOutputNodeId || '';
  if (selectedId.startsWith('material:')) {
    const materialId = selectedId.slice('material:'.length);
    return materialSummary((project.materials || []).find((item) => item.id === materialId));
  }
  const resource = selectedId
    ? (project.nodes || []).find((item) => item.id === selectedId)
    : null;
  const resourceOutput = resourceSummary(resource);
  const latestTask = latestTaskForNode(project, source.id);
  const remoteOutput = extractGeneratedFiles(latestTask?.result?.output || latestTask?.result?.raw || latestTask?.result)
    .find((file: { url?: string }) => String(file.url || '').startsWith('http'));
  if (resourceOutput) return { ...resourceOutput, remoteUrl: remoteOutput?.url || '' };
  const latestMaterial = (project.materials || [])
    .filter((material) => material.source === 'generation' && material.nodeId === source.id)
    .sort((a, b) => new Date(b.importedAt || 0).getTime() - new Date(a.importedAt || 0).getTime())[0];
  if (latestMaterial) return materialSummary(latestMaterial);
  const archived = latestTask?.result?.archivedFiles?.[0];
  if (archived) return materialSummary(archived);
  return null;
}

export function generationUpstreamReadiness(node: CanvasNode | null | undefined, project: CanvasProject | null | undefined): GenerationReadiness {
  if (!node || !project) return { ready: false, issues: ['节点或项目不存在'] };
  const inputs = collectUpstreamInputs(node, project);
  const issues: string[] = [];
  const selectedModel = String(node.model || '');
  if (!isModelForType(node.type, selectedModel)) {
    issues.push(`${node.title}：模型 ${selectedModel || '未设置'} 不是统一模型目录中启用的 ${node.type} 模型，请重新选择`);
  }
  const requiredInputs = inputs.filter((input) => input.required !== false);
  const hasRequiredMedia = requiredInputs.some((input) => effectiveInputRole(input) !== 'textContext');
  const modeResolution = getModelInputCapabilityForRoles(
    node.type,
    selectedModel,
    requiredInputs.map(effectiveInputRole),
    hasRequiredMedia ? resolveModeIdForInputMode(selectedModel, node.inputMode) : '',
  );
  const capability = modeResolution.capability;
  if (!modeResolution.supported) {
    issues.push(`${node.title}：模型 ${selectedModel} 没有能同时满足当前全部输入角色的单一 mode`);
  }
  const activeInputMode: GenerationInputModeDescriptor | undefined = getGenerationInputModes(selectedModel)
    .find((item) => item.value === node.inputMode);
  if (node.inputMode && !activeInputMode) {
    issues.push(`${node.title}：模型 ${selectedModel} 不支持输入模式 ${node.inputMode}`);
  }
  const occupiedSlots = new Set<GenerationInputSlot>();
  for (const input of requiredInputs.filter((item) => effectiveInputRole(item) !== 'textContext')) {
    const slot = input.inputSlot || '';
    if (activeInputMode && !slot) {
      issues.push(`${input.title} 缺少明确的输入槽位`);
      continue;
    }
    if (activeInputMode && !isSlotValidForMode(activeInputMode.value, slot, effectiveInputRole(input))) {
      issues.push(`${input.title} 的槽位 ${slot} 不属于 ${activeInputMode.label} 模式`);
    }
    if ((['firstFrame', 'lastFrame'] as string[]).includes(slot) && occupiedSlots.has(slot)) {
      issues.push(`${node.title} 的 ${slot === 'firstFrame' ? '首帧' : '尾帧'}槽位只能连接一个输入`);
    }
    occupiedSlots.add(slot);
  }
  const imageInputs = requiredInputs.filter((input) => (['image', 'referenceImage'] as string[]).includes(effectiveInputRole(input)));
  const videoInputs = requiredInputs.filter((input) => effectiveInputRole(input) === 'inputVideo');
  const audioInputs = requiredInputs.filter((input) => effectiveInputRole(input) === 'referenceAudio');
  if (imageInputs.length < (capability.minInputImages || 0)) {
    issues.push(`${node.title} 至少需要 ${capability.minInputImages} 个图片输入`);
  }
  if (capability.maxInputImages > 0 && imageInputs.length > capability.maxInputImages) {
    issues.push(`${node.title} 图片输入共 ${imageInputs.length} 个，超过当前模型上限 ${capability.maxInputImages}`);
  }
  if (videoInputs.length < (capability.minInputVideos || 0)) {
    issues.push(`${node.title} 至少需要 ${capability.minInputVideos} 个视频输入`);
  }
  if (capability.maxInputVideos >= 0 && videoInputs.length > capability.maxInputVideos) {
    issues.push(`${node.title} 视频输入共 ${videoInputs.length} 个，超过当前模型上限 ${capability.maxInputVideos}`);
  }
  if (audioInputs.length < (capability.minInputAudios || 0)) {
    issues.push(`${node.title} 至少需要 ${capability.minInputAudios} 个音频输入`);
  }
  if (capability.maxInputAudios >= 0 && audioInputs.length > capability.maxInputAudios) {
    issues.push(`${node.title} 音频输入共 ${audioInputs.length} 个，超过当前模型上限 ${capability.maxInputAudios}`);
  }
  const maxTotalAudioDuration = Number(capability.inputConstraints?.audios?.maxTotalDuration || 0);
  const totalAudioDuration = audioInputs.reduce((total, input) => (
    total + Number(resolvedInputResource(input).duration || 0)
  ), 0);
  if (maxTotalAudioDuration > 0 && totalAudioDuration > maxTotalAudioDuration) {
    issues.push(`${node.title} 的参考音频总时长不能超过 ${maxTotalAudioDuration} 秒`);
  }
  const audioRequirements = capability.inputConstraints?.audios?.requiresAnyOf || [];
  if (audioInputs.length && audioRequirements.length) {
    const satisfied = audioRequirements.some((kind) => (
      (kind === 'images' && imageInputs.length > 0)
      || (kind === 'videos' && videoInputs.length > 0)
      || (kind === 'audios' && audioInputs.length > 0)
    ));
    if (!satisfied) issues.push(`${node.title} 的参考音频必须同时搭配${mediaKindsLabel(audioRequirements)}`);
  }
  for (const input of inputs) {
    if (input.required === false) continue;
    const declaredRole = input.inputRole || 'auto';
    const role = effectiveInputRole(input);
    const uploadedResource = uploadedInputResource(input);
    const hasManualTextContent = input.nodeType === 'textGeneration'
      && Boolean(String(input.prompt || '').trim());
    if (GENERATION_SOURCE_TYPES.includes(input.nodeType)
      && input.status !== 'completed' && !uploadedResource && !hasManualTextContent) {
      issues.push(`${input.title} 尚未完成，不能作为 ${role} 输入`);
      continue;
    }
    if (role === 'textContext' && !String(input.prompt || '').trim()) {
      issues.push(`${input.title} 没有可用的文本结果`);
    }
    if (role === 'referenceImage') {
      const selectedImage = resolvedInputResource(input);
      if (!isImageResource(selectedImage)) issues.push(`${input.title} 没有可用的图片输出`);
      if (capability.imageValueFormat === 'http-url'
        && !String(selectedImage.remoteUrl || selectedImage.url || '').startsWith('http')) {
        issues.push(`${input.title} 没有当前模型要求的 HTTP 图片地址`);
      }
      if (!capability.supportsReferenceImages) issues.push(`${node.title} 当前模型不支持参考图片`);
    }
    if (role === 'inputVideo') {
      if (!isVideoResource(resolvedInputResource(input))) issues.push(`${input.title} 没有可用的视频输出`);
      if (!capability.supportsInputVideo) issues.push(`${node.title} 当前模型不支持 inputVideo`);
    }
    if (role === 'referenceAudio') {
      const selectedAudio = resolvedInputResource(input);
      if (!isAudioResource(selectedAudio)) issues.push(`${input.title} 没有可用的音频输出`);
      if (!capability.supportsInputAudio) issues.push(`${node.title} 当前模型不支持 referenceAudio`);
      const audioConstraint: Partial<NonNullable<CatalogInputConstraints['audios']>> = capability.inputConstraints?.audios || {};
      const format = resourceExtension(selectedAudio);
      if (format && audioConstraint.formats?.length && !audioConstraint.formats.includes(format)) {
        issues.push(`${input.title} 的 ${format} 格式不受当前模型支持`);
      }
      const size = Number(selectedAudio.size || 0);
      if (size > 0 && (audioConstraint.maxBytes || 0) > 0 && size > (audioConstraint.maxBytes || 0)) {
        issues.push(`${input.title} 超过当前模型单个音频大小限制`);
      }
      const duration = Number(selectedAudio.duration || 0);
      if (duration > 0 && (audioConstraint.minDuration || 0) > 0 && duration < (audioConstraint.minDuration || 0)) {
        issues.push(`${input.title} 时长不能少于 ${audioConstraint.minDuration} 秒`);
      }
      if (duration > 0 && (audioConstraint.maxDuration || 0) > 0 && duration > (audioConstraint.maxDuration || 0)) {
        issues.push(`${input.title} 时长不能超过 ${audioConstraint.maxDuration} 秒`);
      }
    }
    if (declaredRole === 'auto' && (['imageGeneration', 'videoGeneration'] as string[]).includes(input.nodeType)
      && !input.selectedOutput && !uploadedResource) {
      issues.push(`${input.title} 已连线但没有可用的生成输出`);
    }
  }
  return { ready: issues.length === 0, issues, inputs };
}

function materialSummary(material: MaterialRecord | null | undefined): SelectedOutputSummary | null {
  if (!material) return null;
  return {
    materialId: material.id || '',
    nodeId: material.nodeId || '',
    title: pickString(material.name, '输出资源'),
    content: pickString(material.path || material.previewUrl || material.name),
    resourceType: material.resourceType || '',
    fileName: material.name || '',
    filePath: material.path || material.filePath || '',
    url: material.url || material.resourceUrl || '',
    previewUrl: material.previewUrl || '',
    remoteUrl: material.remoteUrl || '',
    objectKey: material.objectKey || '',
    mimeType: material.mimeType || '',
    size: material.size || 0,
    duration: material.duration || 0,
  };
}

function resourceSummary(source: CanvasNode | null | undefined): ResourceSummary | null {
  if (!source || source.type !== 'resource' || source.archived) return null;
  return {
    nodeId: source.id || '',
    title: pickString(source.title || source.fileName, '资源'),
    content: pickString(source.content || source.filePath || source.url || source.previewUrl),
    resourceType: source.resourceType || '',
    fileName: source.fileName || '',
    filePath: source.filePath || '',
    url: source.url || source.resourceUrl || '',
    previewUrl: source.previewUrl || '',
    remoteUrl: source.remoteUrl || '',
    objectKey: source.objectKey || '',
    materialId: source.materialId || '',
    mimeType: source.mimeType || '',
    size: source.size || 0,
    duration: source.duration || 0,
  };
}

function isImageResource(resource: ModelInputResource = {}): boolean {
  const type = String(resource.resourceType || resource.mimeType || '').toLowerCase();
  const ext = String(resource.fileName || resource.filePath || resource.url || resource.previewUrl || '').split(/[?#]/)[0]?.split('.').pop()?.toLowerCase() || '';
  return type.includes('image') || ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp', 'svg'].includes(ext);
}

function isVideoResource(resource: ModelInputResource = {}): boolean {
  const type = String(resource.resourceType || resource.mimeType || '').toLowerCase();
  const ext = String(resource.fileName || resource.filePath || resource.url || resource.previewUrl || '').split(/[?#]/)[0]?.split('.').pop()?.toLowerCase() || '';
  return type.includes('video') || ['mp4', 'mov', 'webm', 'm4v'].includes(ext);
}

function isAudioResource(resource: ModelInputResource = {}): boolean {
  const type = String(resource.resourceType || resource.mimeType || '').toLowerCase();
  const ext = resourceExtension(resource);
  return type.includes('audio') || ['wav', 'mp3', 'm4a', 'aac', 'ogg', 'flac'].includes(ext);
}

function resourceExtension(resource: ModelInputResource = {}): string {
  return String(resource.fileName || resource.filePath || resource.url || resource.previewUrl || '')
    .split(/[?#]/)[0]?.split('.').pop()?.toLowerCase() || '';
}

function mediaKindsLabel(kinds: Array<'images' | 'videos' | 'audios'> = []): string {
  const labels: Record<string, string> = { images: '至少一张图片', videos: '至少一个视频', audios: '至少一个音频' };
  return kinds.map((kind) => labels[kind] || kind).join('或');
}

function inputResourcePayload(resource: ModelInputResource = {}, source: ModelInputResource = {}): InputResource {
  return {
    nodeId: source.nodeId || resource.nodeId || '',
    title: resource.title || source.title || '',
    resourceType: resource.resourceType || '',
    fileName: resource.fileName || '',
    filePath: resource.filePath || '',
    url: resource.url || resource.previewUrl || '',
    previewUrl: resource.previewUrl || '',
    remoteUrl: resource.remoteUrl || '',
    objectKey: resource.objectKey || '',
    materialId: resource.materialId || '',
    mimeType: resource.mimeType || '',
    size: resource.size || 0,
    duration: resource.duration || 0,
    inputRole: normalizeInputRole(source.inputRole || resource.inputRole || 'auto'),
    inputSlot: source.inputSlot || resource.inputSlot || '',
    required: source.required !== false && resource.required !== false,
  };
}


// uploadedFilePayload 不携带时长，与原实现一致：候选资源时长统一按 0 处理。
function uploadedInputResource(input: UpstreamInput | ModelInputResource): ModelInputResource | null {
  const uploaded = input.uploadedFile;
  if (!uploaded || (!uploaded.path && !uploaded.url)) return null;
  return inputResourcePayload({
    title: uploaded.name || input.title || '',
    resourceType: uploaded.resourceType,
    fileName: uploaded.name,
    filePath: uploaded.path,
    url: uploaded.url,
    materialId: uploaded.materialId,
    mimeType: uploaded.type,
    size: uploaded.size || 0,
    duration: 0,
  }, input);
}

function resolvedInputResource(input: UpstreamInput | ModelInputResource = {}): ModelInputResource {
  return input.selectedOutput || uploadedInputResource(input) || input;
}

function effectiveInputRole(input: UpstreamInput | ModelInputResource = {}): string {
  const role = input.inputRole || 'auto';
  if (role !== 'auto') return role;
  const resource = resolvedInputResource(input);
  if (isImageResource(resource)) return 'image';
  if (isVideoResource(resource)) return 'inputVideo';
  if (isAudioResource(resource)) return 'referenceAudio';
  return role;
}

function collectCandidateResources(inputs: UpstreamInput[] = [], uploadedFile: UploadedFilePayload | null = null): ModelInputResource[] {
  const candidates: ModelInputResource[] = [];
  if (uploadedFile?.path || uploadedFile?.url) {
    candidates.push(inputResourcePayload({
      title: uploadedFile.name,
      resourceType: uploadedFile.resourceType,
      fileName: uploadedFile.name,
      filePath: uploadedFile.path,
      url: uploadedFile.url,
      materialId: uploadedFile.materialId,
      mimeType: uploadedFile.type,
      size: uploadedFile.size || 0,
      duration: 0,
    }));
  }
  for (const input of inputs || []) {
    if (input.uploadedFile?.path || input.uploadedFile?.url) {
      candidates.push(inputResourcePayload({
        title: input.uploadedFile.name || input.title,
        resourceType: input.uploadedFile.resourceType,
        fileName: input.uploadedFile.name,
        filePath: input.uploadedFile.path,
        materialId: input.uploadedFile.materialId,
        mimeType: input.uploadedFile.type,
        size: input.uploadedFile.size || 0,
        duration: 0,
      }, input));
    }
    if (input.selectedOutput) {
      candidates.push(inputResourcePayload(input.selectedOutput, input));
      continue;
    }
    if (input.filePath || input.remoteUrl || input.url || input.previewUrl || input.objectKey) {
      candidates.push(inputResourcePayload(input, input));
    }
  }
  return candidates;
}

function collectModelInputs({ inputs, uploadedFile, capability, inputStrategy = 'auto' }: {
  inputs: UpstreamInput[];
  uploadedFile: UploadedFilePayload | null;
  capability: ModelRuntimeContract | null;
  inputStrategy: string;
}): GenerationInputs {
  const candidates = collectCandidateResources(inputs, uploadedFile);
  const maxImages = capability?.maxInputImages || 0;
  const resourceKey = (item: ModelInputResource = {}) => item?.filePath || item?.url || item?.previewUrl || item?.objectKey || item?.materialId || item?.nodeId || '';
  const imageCandidates = candidates
    .filter(isImageResource)
    .filter((item, index, items) => items.findIndex((candidate) => resourceKey(candidate) === resourceKey(item)) === index);
  const usedImageKeys = new Set<string>();
  const withinImageBudget = () => usedImageKeys.size < maxImages;
  const claimImage = (item: ModelInputResource): ModelInputResource | null => {
    const key = resourceKey(item);
    if (!item || !key || usedImageKeys.has(key) || !withinImageBudget()) return null;
    usedImageKeys.add(key);
    return item;
  };
  const explicitReferenceCandidates = imageCandidates.filter((item) => item.inputRole === 'referenceImage');
  const autoCandidates = imageCandidates.filter((item) => item.inputRole === 'auto');
  const images: ModelInputResource[] = [];
  if (capability?.supportsReferenceImages) {
    explicitReferenceCandidates.forEach((item) => {
      const claimed = claimImage(item);
      if (claimed) images.push(claimed);
    });
  }
  if (capability?.supportsReferenceImages && inputStrategy === 'referenceImages') {
    autoCandidates.forEach((item) => {
      const claimed = claimImage(item);
      if (claimed) images.push(claimed);
    });
  }
  if (capability?.supportsInputImages) {
    autoCandidates.forEach((item) => {
      const claimed = claimImage(item);
      if (claimed) images.push(claimed);
    });
  }
  const videos = candidates
    .filter(isVideoResource)
    .map((item) => item.inputRole === 'auto' ? { ...item, inputRole: 'inputVideo' } : item)
    .sort((a, b) => Number(b.inputRole === 'inputVideo') - Number(a.inputRole === 'inputVideo'))
    .slice(0, capability?.maxInputVideos || 0);
  const audios = candidates
    .filter(isAudioResource)
    .map((item) => item.inputRole === 'auto' ? { ...item, inputRole: 'referenceAudio' } : item)
    .sort((a, b) => Number(b.inputRole === 'referenceAudio') - Number(a.inputRole === 'referenceAudio'))
    .slice(0, capability?.maxInputAudios || 0);
  return {
    images,
    videos: capability?.supportsInputVideo ? videos : [],
    audios: capability?.supportsInputAudio ? audios : [],
  };
}

export function summarizeGenerationPayload(payload: GenerationPayload | null | undefined): Record<string, unknown> {
  const summarized: Record<string, unknown> = Object.fromEntries(
    Object.entries(payload || {}).filter(([, value]) => value !== undefined && value !== null && value !== ''),
  );
  delete summarized.upstreamContext;
  const compactResource = (resource: ModelInputResource = {}) => ({
    nodeId: resource.nodeId || '',
    title: resource.title || '',
    resourceType: resource.resourceType || '',
    fileName: resource.fileName || '',
    filePath: resource.filePath || '',
    url: resource.url || '',
    previewUrl: resource.previewUrl || '',
    remoteUrl: resource.remoteUrl || '',
    objectKey: resource.objectKey || '',
    materialId: resource.materialId || '',
    mimeType: resource.mimeType || '',
    size: resource.size || 0,
    inputRole: resource.inputRole || 'auto',
    inputSlot: resource.inputSlot || '',
    duration: resource.duration || 0,
    required: resource.required !== false,
  });
  summarized.inputs = (payload?.inputs || []).map((input) => ({
    edgeId: input.edgeId || '',
    inputRole: input.inputRole || 'auto',
    inputSlot: input.inputSlot || '',
    required: input.required !== false,
    nodeId: input.nodeId || '',
    nodeType: input.nodeType || '',
    title: input.title || '',
    status: input.status || '',
    taskId: input.taskId || '',
    uploadedFile: input.uploadedFile ? compactResource(input.uploadedFile) : null,
    selectedOutput: input.selectedOutput ? compactResource(input.selectedOutput) : null,
  }));
  if (payload?.modelInputs) {
    summarized.modelInputs = {
      images: (payload.modelInputs.images || []).map(compactResource),
      videos: (payload.modelInputs.videos || []).map(compactResource),
      audios: (payload.modelInputs.audios || []).map(compactResource),
    };
  }
  return summarized;
}
