// 模型参数在目录里是松散的 JSON 结构，界面只按当前真实字段读取。
type AnyRecord = Record<string, any>;

export function optionValue(option: any) {
  return option && typeof option === 'object' ? option.value ?? option.label : option;
}

export function modelTypeLabel(type: string) {
  const labels: Record<string, string> = {
    textGeneration: '文本生成',
    imageGeneration: '图片生成',
    videoGeneration: '视频生成',
    audioGeneration: '音频生成',
  };
  return labels[type] || type || '未知类型';
}

export function optionLabel(param: AnyRecord, value: any) {
  if (param.optionLabels?.[value] != null) return String(param.optionLabels[value]);
  const option = (param.options || []).find((item: any) => optionValue(item) === value);
  if (option && typeof option === 'object') return option.label ?? option.value ?? value;
  return String(option ?? value ?? param.default ?? '');
}

export function isAspectRatioParam(param: AnyRecord) {
  const control = param.presentation && typeof param.presentation === 'object'
    ? param.presentation.control
    : param.presentation;
  return control === 'ratio' || control === 'aspectRatio'
    || param.key === 'aspectRatio'
    || String(param.label || '').includes('比例');
}

export function paramPresentation(param: AnyRecord | null | undefined): AnyRecord {
  return param?.presentation && typeof param.presentation === 'object'
    ? param.presentation
    : {};
}

/** 对数滑杆的轨道域：只描述拖动位置，写回配置的仍是目录 step 量化后的真实值。 */
const LOG_SLIDER_RANGE = 1000;

/** 倍率型参数（语速 0.5–2、音量 0.1–10）的默认值 1 在线性轨道上贴着左端，看起来像空轨；
 *  目录声明 scale:'log' 后几何中点落在轨道正中。min<=0 时无法取对数，按线性处理。 */
function usesLogSlider(param: AnyRecord): boolean {
  const presentation = paramPresentation(param);
  const min = Number(presentation.min);
  const max = Number(presentation.max);
  return presentation.scale === 'log' && Number.isFinite(min) && min > 0 && max > min;
}

export function sliderTrackDomain(param: AnyRecord): { min: number; max: number; step: number } {
  const presentation = paramPresentation(param);
  if (!usesLogSlider(param)) {
    return {
      min: Number(presentation.min),
      max: Number(presentation.max),
      step: Number(presentation.step) || 1,
    };
  }
  return { min: 0, max: LOG_SLIDER_RANGE, step: 1 };
}

export function sliderTrackPosition(param: AnyRecord, value: number): number {
  if (!usesLogSlider(param)) return value;
  const presentation = paramPresentation(param);
  const min = Number(presentation.min);
  const max = Number(presentation.max);
  const clamped = Math.min(max, Math.max(min, value));
  return Math.round((Math.log(clamped / min) / Math.log(max / min)) * LOG_SLIDER_RANGE);
}

export function sliderValueFromTrack(param: AnyRecord, position: number): number {
  if (!usesLogSlider(param)) return position;
  const presentation = paramPresentation(param);
  const min = Number(presentation.min);
  const max = Number(presentation.max);
  const decimals = String(presentation.step ?? '').split('.')[1]?.length || 0;
  const raw = min * Math.pow(max / min, position / LOG_SLIDER_RANGE);
  return Number(Math.min(max, Math.max(min, raw)).toFixed(decimals));
}

export function aspectRatioStyle(value: any) {
  const match = String(value || '1:1').trim().match(
    /([0-9]+(?:\.[0-9]+)?)\s*(?::|x|×|\/)\s*([0-9]+(?:\.[0-9]+)?)/i,
  );
  const rawWidth = Number(match?.[1]);
  const rawHeight = Number(match?.[2]);
  const width = Number.isFinite(rawWidth) && rawWidth > 0 ? rawWidth : 1;
  const height = Number.isFinite(rawHeight) && rawHeight > 0 ? rawHeight : 1;
  const ratio = width / height;
  return {
    width: `${ratio >= 1 ? 18 : Math.max(9, Math.round(18 * ratio))}px`,
    height: `${ratio >= 1 ? Math.max(9, Math.round(18 / ratio)) : 18}px`,
  };
}

export function modelDescription(model = '', type = '') {
  const value = String(model).toLowerCase();
  const descriptions: [((value: string) => boolean), string][] = [
    [(v) => v.includes('gpt-image'), 'StarRouter /v1/images/generations 图片模型'],
    [(v) => v.includes('doubao') || v.includes('seedream'), 'StarRouter 可用图片/视频模型，需对应专用 endpoint'],
    [(v) => v.includes('grok') && v.includes('image'), 'xAI 图像模型，StarRouter 可用'],
    [(v) => v.includes('gemini') && v.includes('image'), 'Gemini 图像模型，StarRouter 可用'],
    [(v) => v.includes('midjourney'), '风格感强，适合艺术视觉和氛围图'],
    [(v) => v.includes('flux'), '写实稳定，适合角色与产品细节'],
    [(v) => v.includes('sdxl') || v.includes('stable'), '本地/开源生态，适合可控生成'],
    [(v) => v.includes('kling'), '快手 Kling 视频模型，适合图生视频和镜头运动'],
    [(v) => v.includes('seedance'), '豆包 Seedance 视频模型，适合短片和镜头生成'],
    [(v) => v.includes('vidu'), 'Vidu 视频模型，适合短视频生成'],
    [(v) => v.includes('veo'), 'Google Veo 视频模型'],
    [(v) => v.includes('grok') && v.includes('video'), 'xAI 视频模型，StarRouter 可用'],
    [(v) => v.includes('sora'), '长镜头与复杂运动表现更强'],
    [(v) => v.includes('runway'), '视频编辑和商业短片常用'],
    [(v) => v.includes('pika'), '轻量短视频生成'], [(v) => v.includes('luma'), '镜头感和空间运动较好'],
    [(v) => v.includes('suno'), '音乐、歌词和歌曲生成'],
    [(v) => v.includes('whisper') || v.includes('asr'), '语音识别/音频转写模型'],
    [(v) => v.includes('pawsense'), '音频理解模型'], [(v) => v.includes('udio'), '音乐质感和编曲表现较好'],
    [(v) => v.includes('eleven'), '语音、旁白和角色声音'],
    [(v) => v.includes('gemini'), 'Gemini 文本/多模态模型'], [(v) => v.includes('deepseek'), 'DeepSeek 推理和结构化文本'],
    [(v) => v.includes('qwen'), '通义千问文本/视觉语言模型'], [(v) => v.includes('gpt'), 'OpenAI-compatible 文本模型'],
    [(v) => v.includes('grok'), 'xAI 文本模型'],
  ];
  const matched = descriptions.find(([matches]) => matches(value));
  if (matched) return matched[1];
  const fallbacks: Record<string, string> = {
    imageGeneration: '图片生成模型',
    videoGeneration: '视频生成模型',
    audioGeneration: '音频生成模型',
  };
  return fallbacks[type] || '文本生成模型';
}
