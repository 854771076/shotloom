import { editorProjectToOpenVideo } from '../utils/videoEditorProject.ts';

// OpenVideo 工程是编辑器与引擎之间往返的松散 JSON：片段、轨道与设置由双方按需读写。
type AnyRecord = Record<string, any>;

const US_PER_SECOND = 1_000_000;
let metadataProviderReady = false;

function secondsToUs(value: unknown): number {
  return Math.max(0, Math.round((Number(value) || 0) * US_PER_SECOND));
}

function projectDuration(segments: AnyRecord[] = []): number {
  return segments.reduce((total, segment) => {
    const speed = Math.max(0.5, Math.min(2, Number(segment.speed) || 1));
    return total + Math.max(0, segment.end - segment.start) / speed;
  }, 0);
}

export function getOpenVideoRuntimeSupport() {
  const canvas = typeof document === 'undefined' ? null : document.createElement('canvas');
  return {
    preview: Boolean(canvas?.getContext('webgl2') || canvas?.getContext('webgl')),
    browserEncoding: typeof VideoEncoder !== 'undefined' && typeof AudioEncoder !== 'undefined',
  };
}

export function createOpenVideoProject({
  sourceUrl,
  sourceName = 'video.mp4',
  segments = [],
  width = 1920,
  height = 1080,
  fps = 30,
}: {
  sourceUrl?: string;
  sourceName?: string;
  segments?: AnyRecord[];
  width?: number;
  height?: number;
  fps?: number;
} = {}) {
  const duration = projectDuration(segments);
  let cursor = 0;
  const clips: Record<string, AnyRecord> = {};
  const clipIds: string[] = [];

  segments.forEach((segment, index) => {
    const speed = Math.max(0.5, Math.min(2, Number(segment.speed) || 1));
    const clipDuration = Math.max(0, Number(segment.end) - Number(segment.start)) / speed;
    if (!clipDuration) return;
    const id = String(segment.id || `video-${index + 1}`);
    const from = secondsToUs(cursor);
    const to = secondsToUs(cursor + clipDuration);
    clips[id] = {
      id,
      type: 'Video',
      src: sourceUrl,
      name: `${sourceName} · ${String(index + 1).padStart(2, '0')}`,
      timing: {
        display: { from, to },
        trim: { from: secondsToUs(segment.start), to: secondsToUs(segment.end) },
        duration: to - from,
        playbackRate: speed,
      },
      transform: {
        x: 0,
        y: 0,
        width,
        height,
        angle: 0,
        opacity: 1,
        zIndex: 10,
        flip: { x: false, y: false },
      },
      style: {},
      volume: segment.muted ? 0 : 1,
      locked: false,
      effects: [],
      animations: [],
    };
    clipIds.push(id);
    cursor += clipDuration;
  });

  return {
    settings: {
      width,
      height,
      fps,
      duration: secondsToUs(duration),
      backgroundColor: '#050608',
    },
    tracks: [{
      id: 'main-video',
      name: '主画面',
      type: 'Video',
      clipIds,
      accepts: ['Video', 'Image'],
    }],
    clips,
  };
}

export function createOpenVideoStudioProject(project: AnyRecord) {
  const converted = editorProjectToOpenVideo(project);
  const interactiveTypes = new Set(['Text', 'Image']);
  const clips: Record<string, AnyRecord> = Object.fromEntries(
    Object.entries(converted.clips as Record<string, AnyRecord>).filter(([, clip]) => !interactiveTypes.has(clip.type)),
  );
  const tracks = (converted.tracks as AnyRecord[])
    .map((track): AnyRecord => ({
      ...track,
      clipIds: (track.clipIds as string[]).filter((id) => clips[id]),
    }))
    .filter((track) => track.clipIds.length > 0 || ['Video', 'Audio', 'Effect'].includes(track.type));
  return { ...converted, tracks, clips };
}

export async function createOpenVideoRuntime({
  canvas,
  project,
  previewScale = 0.75,
  onTime,
  onPlayingChange,
}: {
  canvas?: HTMLCanvasElement;
  project: unknown;
  previewScale?: number;
  onTime?: (seconds: number) => void;
  onPlayingChange?: (playing: boolean) => void;
}) {
  // 工程由编辑器导出，服务只读取尺寸设置并整体交给引擎，不解释其结构。
  const engineProject = project as AnyRecord;
  const [{ BrowserMetadataProvider, Core, CoreConfig }, { Studio }] = await Promise.all([
    import('@openvideo/core'),
    import('@openvideo/engine-pixi'),
  ]);
  if (!metadataProviderReady) {
    CoreConfig.setMetadataProvider(new BrowserMetadataProvider());
    metadataProviderReady = true;
  }
  const core = new Core(engineProject);
  const studio = new Studio({
    width: engineProject.settings.width,
    height: engineProject.settings.height,
    fps: engineProject.settings.fps,
    backgroundColor: '#11151a',
    artboardColor: '#050608',
    // IStudioOpts.canvas 是 `HTMLCanvasElement`（不带 undefined），exactOptionalPropertyTypes
    // 下不能显式传 undefined，所以没有画布时直接省略这个键。
    ...(canvas ? { canvas } : {}),
    core,
    // 片段交互由监视器的 HTML 浮层统一承担（与贴图/文字同一条路径），引擎只负责渲染。
    // 视口的缩放与平移是独立开关，不受影响。
    interactivity: false,
    allowZoom: true,
    allowPan: true,
    previewScale,
  });
  if (onTime) studio.on('currentTime', ({ currentTime }: { currentTime: number }) => onTime(currentTime / US_PER_SECOND));
  studio.on('play', () => onPlayingChange?.(true));
  studio.on('pause', () => onPlayingChange?.(false));
  await studio.ready;

  return {
    core,
    studio,
    replaceProject(nextProject: unknown) {
      core.project.import(nextProject as AnyRecord);
    },
    exportProject() {
      return core.project.export();
    },
    selectClip(id: string) {
      studio.selectClipsByIds(id ? [id] : []);
    },
    updateClip(id: string, updates: AnyRecord) {
      return studio.updateClip(id, updates);
    },
    async centerClip(id: string) {
      await studio.centerClip(id);
      return studio.exportToJSON().clips[id]?.transform;
    },
    async fitClip(id: string) {
      await studio.scaleToFit(id);
      await studio.centerClip(id);
      return studio.exportToJSON().clips[id]?.transform;
    },
    async coverClip(id: string) {
      await studio.scaleToCover(id);
      await studio.centerClip(id);
      return studio.exportToJSON().clips[id]?.transform;
    },
    undo() {
      return studio.undo();
    },
    redo() {
      return studio.redo();
    },
    resetView() {
      studio.resetView();
    },
    seek(seconds: number) {
      return studio.seek(secondsToUs(seconds));
    },
    play() {
      return studio.play();
    },
    pause() {
      studio.pause();
    },
    frameNext() {
      return studio.frameNext();
    },
    framePrev() {
      return studio.framePrev();
    },
    destroy() {
      studio.destroy();
    },
  };
}
