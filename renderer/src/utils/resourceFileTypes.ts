export const RESOURCE_FILE_EXTENSIONS = Object.freeze({
  image: Object.freeze(['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp', 'svg']),
  video: Object.freeze(['mp4', 'mov', 'webm', 'm4v']),
  audio: Object.freeze(['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac']),
  text: Object.freeze(['txt', 'md', 'json', 'csv', 'log']),
});

const RESOURCE_FILE_LABELS = Object.freeze({
  image: '图片',
  video: '视频',
  audio: '音频',
  text: '文本',
});

export function resourceFileDialogFilters(resourceType: string) {
  const extensions = (RESOURCE_FILE_EXTENSIONS as Record<string, readonly string[]>)[resourceType];
  if (!extensions) return undefined;
  const labels = RESOURCE_FILE_LABELS as Record<string, string>;
  // extensions 存在时 key 必然来自同一组四类，label 必然存在。
  return [{ name: labels[resourceType] as string, extensions: [...extensions] }];
}
