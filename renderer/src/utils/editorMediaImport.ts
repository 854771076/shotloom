const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp']);
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg']);

type MediaFacts = { duration: number; width: number; height: number };

function extensionOf(path = '') {
  return String(path).split(/[?#]/)[0]?.split('.').pop()?.toLowerCase() || '';
}

export function inferEditorMediaType(path = ''): 'image' | 'audio' | 'video' {
  const extension = extensionOf(path);
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (AUDIO_EXTENSIONS.has(extension)) return 'audio';
  return 'video';
}

export function editorMediaMimeType(path = '', type: string = inferEditorMediaType(path)) {
  const extension = extensionOf(path);
  const known: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    bmp: 'image/bmp',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    m4a: 'audio/mp4',
    aac: 'audio/aac',
    flac: 'audio/flac',
    ogg: type === 'video' ? 'video/ogg' : 'audio/ogg',
    mp4: 'video/mp4',
    m4v: 'video/x-m4v',
    mov: 'video/quicktime',
    webm: 'video/webm',
    mkv: 'video/x-matroska',
    avi: 'video/x-msvideo',
  };
  return known[extension] || `${type}/mp4`;
}

function mediaFacts(media: any, type: string) {
  return {
    duration: type === 'image' ? 0 : Number(media.duration) || 0,
    width: Number(media.videoWidth || media.naturalWidth) || 0,
    height: Number(media.videoHeight || media.naturalHeight) || 0,
  };
}

function factsAreUsable(facts: any, type: string) {
  if (type === 'image') return facts.width > 0 && facts.height > 0;
  return Number.isFinite(facts.duration) && facts.duration > 0;
}

async function probeUrl(type: string, url: string, createElement: (tag: string) => any, timeoutMs: number): Promise<MediaFacts> {
  if (!url) throw new Error('素材地址为空');
  const media = createElement(type === 'image' ? 'img' : type);
  return new Promise((resolve, reject) => {
    let settled = false;
    const eventName = type === 'image' ? 'load' : 'loadedmetadata';
    const cleanup = () => {
      clearTimeout(timer);
      media.removeEventListener(eventName, loaded);
      media.removeEventListener('error', failed);
    };
    const finish = (callback: (value: any) => void, value: any) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const loaded = () => {
      const facts = mediaFacts(media, type);
      if (factsAreUsable(facts, type)) finish(resolve, facts);
      else finish(reject, new Error('素材元数据不完整'));
    };
    const failed = () => finish(reject, new Error('浏览器无法解码该素材'));
    const timer = setTimeout(
      () => finish(reject, new Error('读取素材超时')),
      timeoutMs,
    );
    media.addEventListener(eventName, loaded, { once: true });
    media.addEventListener('error', failed, { once: true });
    if (type !== 'image') media.preload = 'metadata';
    media.src = url;
    if (type !== 'image') media.load?.();
  });
}

/**
 * WebView 的本地资源协议偶尔不会返回媒体元数据。先尝试稳定 URL，
 * 再用一次性的 Blob URL 读取文件头；Blob 只用于探测，不写入工程。
 */
export async function probeEditorMedia({
  type,
  sourceFile,
  sourceUrl,
  createElement = (tag: string) => document.createElement(tag),
  readArrayBuffer,
  probeNative,
  createObjectUrl = (blob: Blob) => URL.createObjectURL(blob),
  revokeObjectUrl = (url: string) => URL.revokeObjectURL(url),
  timeoutMs = 12_000,
}: {
  type: string;
  sourceFile?: string | null;
  sourceUrl?: string | null;
  createElement?: (tag: string) => any;
  readArrayBuffer?: ((path: string) => Promise<any>) | undefined;
  probeNative?: ((path: string | null | undefined) => Promise<any>) | undefined;
  createObjectUrl?: (blob: Blob) => string;
  revokeObjectUrl?: (url: string) => void;
  timeoutMs?: number;
}) {
  const nativeFacts = await probeNative?.(sourceFile).catch(() => null);
  if (nativeFacts && factsAreUsable(nativeFacts, type)) {
    return {
      duration: Number(nativeFacts.duration) || 0,
      width: Number(nativeFacts.width) || 0,
      height: Number(nativeFacts.height) || 0,
    };
  }
  try {
    return await probeUrl(type, sourceUrl || '', createElement, timeoutMs);
  } catch (urlError) {
    if (!sourceFile || !readArrayBuffer) throw urlError;
    const buffer = await readArrayBuffer(sourceFile);
    if (!buffer?.byteLength) throw new Error('素材文件为空');
    const blobUrl = createObjectUrl(
      new Blob([buffer], { type: editorMediaMimeType(sourceFile, type) }),
    );
    try {
      return await probeUrl(type, blobUrl, createElement, timeoutMs);
    } finally {
      revokeObjectUrl(blobUrl);
    }
  }
}
