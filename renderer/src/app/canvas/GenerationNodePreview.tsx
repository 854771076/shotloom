import { useContext, useRef, useState } from "react";
import { reconcileMediaNodeDimensions } from "../../domain/graph/CanvasNodeDimensions";
import { desktopApi } from "../../services/desktopApi.ts";
import { showToast } from "../../store/notificationStore";
import { store } from "../../store/projectStore.ts";
import { copyTextNodeVersion, renameTextNodeVersion } from "../adapters/canvasAdapter";
import { openMediaViewer } from "../store/overlayStore";
import { IconSymbol } from "../components/IconSymbol";
import { GenerationNodeImageOverlays } from "./GenerationNodeImageOverlays";
import { formatMediaTime, GenerationAudioPreview } from "./GenerationAudioPreview";
import { CanvasPreviewZoomContext, type WorkflowNodeActions, type WorkflowNodeData } from "./WorkflowCanvas";
import { useGenerationLocalPreview } from "./generationNodeMedia";
import type { GenerationNodeState } from "./generationNodeState";

/**
 * 空文本节点的快捷入口只写入提示词，不触发运行，
 * 让用户在输入面板里先补充主题再自行发送。
 */
const TEXT_NODE_STARTERS = [
  {
    key: "script",
    label: "剧本生成",
    icon: "film",
    prompt: "写一个可拍摄的短视频剧本：先给出主题与人物，再按镜头列出画面、台词和时长。主题：",
  },
  {
    key: "proposal",
    label: "策划案生成",
    icon: "file",
    prompt: "输出一份内容策划案：项目背景、目标受众、核心创意、内容结构、传播渠道与执行排期。项目：",
  },
  {
    key: "prompt",
    label: "提示词生成",
    icon: "spark",
    prompt: "把下面的主题写成可直接用于图片/视频生成的提示词，补充主体、风格、镜头、光线和氛围。主题：",
  },
];

export function GenerationNodePreview({
  node,
  selected,
  state,
  actions,
  imageCropOpen,
  onImageCropClose,
  imageAnnotationOpen,
  onImageAnnotationClose,
  semanticZoom,
  onStarter,
}: {
  node: WorkflowNodeData;
  selected: boolean;
  state: GenerationNodeState;
  actions: WorkflowNodeActions;
  imageCropOpen: boolean;
  onImageCropClose: (() => void) | undefined;
  imageAnnotationOpen: boolean;
  onImageAnnotationClose: (() => void) | undefined;
  semanticZoom: number;
  onStarter: (prompt: string) => void;
}) {
  const {
    activeFilePath, activeFileName, activeKind, kind, metaIcon, metaLabel,
    outputs, previewItem, selectedOutput, textContent, textPreview, uploaded, uploadedResource,
  } = state;
  const videoPreviewRef = useRef<HTMLVideoElement>(null);
  const [videoTime, setVideoTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);
  const [videoPlaying, setVideoPlaying] = useState(false);
  const [videoMuted, setVideoMuted] = useState(false);
  const [imageSize, setImageSize] = useState({ width: 1, height: 1 });
  const annotationAnchorRef = useRef<HTMLDivElement>(null);
  const previewZoom = useContext(CanvasPreviewZoomContext);
  const {
    url: previewUrl,
    retryBuffered: retryBufferedPreview,
    buffered: bufferedPreview,
  } = useGenerationLocalPreview(previewItem, activeKind, previewZoom);

  function openDetail(withTextAgent: boolean) {
    if (activeKind === "image" || activeKind === "video") {
      if (previewUrl) {
        openMediaViewer({
          src: previewUrl,
          kind: activeKind,
          title: selectedOutput?.title || String(node.title || metaLabel),
          filePath: String(selectedOutput?.filePath || uploaded?.filePath || uploaded?.path || ""),
          ...(activeKind === "video" ? { onCaptureFrame: (seconds: number) => actions.captureVideoFrame(node.id, seconds) } : {}),
        });
      }
    } else if (kind === "text") {
      openMediaViewer({
        src: textContent,
        kind: "text",
        title: String(node.title || "文本详情"),
        filePath: String(selectedOutput?.filePath || ""),
        onSave: (content) => {
          actions.update(node.id, {
            textContent: content,
            generatedOutputs: selectedOutput
              ? outputs.map((output) =>
                  output.id === selectedOutput.id ? { ...output, content } : output,
                )
              : outputs,
            updatedAt: new Date().toISOString(),
          });
        },
        getTextVersions: () => ((store.project.nodes.find((item: WorkflowNodeData) => item.id === node.id) as WorkflowNodeData | undefined)?.textVersions || []) as Array<{ id: string; content: string; createdAt: string; name?: string }>,
        onRenameVersion: (id, name) => renameTextNodeVersion(node.id, id, name),
        onCopyVersion: (id) => copyTextNodeVersion(node.id, id),
        textAgentNodeId: withTextAgent ? node.id : "",
      });
    }
  }
  async function saveActiveMedia() {
    if (!activeFilePath) return showToast("当前媒体没有可导出的本地原始文件");
    try {
      const buffer = await desktopApi.file.readArrayBuffer(activeFilePath);
      const result = await desktopApi.file.saveArrayBuffer(activeFileName, buffer);
      if (result) showToast("媒体已另存");
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : "媒体另存失败");
    }
  }

  // Keep the media branch explicit: activeKind === 'image' && previewUrl ? <img /> : activeKind === 'video'.
  return (
    <div className="work-visual-block">
      <div className={`work-node work-node-${kind}${selected ? " selected" : ""}`}>
        <div
          ref={annotationAnchorRef}
          className={`work-preview ${
            node.type === "videoGeneration" ? "wide" : "square"
          } ${kind}`}
          title={kind === "text" ? "双击编辑节点内容" : previewUrl ? "双击查看详情" : ""}
          onDoubleClick={imageCropOpen ? undefined : () => openDetail(false)}
          onPointerEnter={() => {
            if (activeKind !== "video" || !previewUrl) return;
            const video = videoPreviewRef.current;
            if (!video) return;
            video.muted = videoMuted;
            video.volume = 1;
            void video.play().catch(() => undefined);
          }}
          onPointerLeave={(event) => {
            if (activeKind !== "video" || !previewUrl || event.buttons) return;
            videoPreviewRef.current?.pause();
          }}
        >
          {kind === "text" ? (
            textContent ? (
              <div className="text-result-scroll">
                <p>{textPreview}</p>
              </div>
            ) : (
              <div className="text-result-empty">
                <IconSymbol className="text-result-sheet" name="sheet" />
                <div className="text-result-starters nodrag nopan">
                  <span>试试：</span>
                  <button
                    type="button"
                    className="text-result-starter"
                    onClick={(event) => {
                      event.stopPropagation();
                      // 只有"自己编写内容"这条路径带文本 Agent；双击和工具栏入口保持纯编辑器。
                      openDetail(true);
                    }}
                  >
                    <IconSymbol name="pencil" />
                    自己编写内容
                  </button>
                  {/* 生成型 starter 会把提示词写进下方输入面板；纯上传资源节点没有那个面板。 */}
                  {!uploadedResource && TEXT_NODE_STARTERS.map((starter) => (
                    <button
                      key={starter.key}
                      type="button"
                      className="text-result-starter"
                      onClick={(event) => {
                        event.stopPropagation();
                        onStarter(starter.prompt);
                      }}
                    >
                      <IconSymbol name={starter.icon} />
                      {starter.label}
                    </button>
                  ))}
                </div>
              </div>
            )
          ) : activeKind === "image" && previewUrl ? (
            <img
              src={previewUrl}
              alt={String(node.title || metaLabel)}
              onLoad={(event) => {
                const image = event.currentTarget;
                setImageSize({ width: image.naturalWidth, height: image.naturalHeight });
                const dimensions = reconcileMediaNodeDimensions(
                  node,
                  image.naturalWidth,
                  image.naturalHeight,
                );
                if (dimensions) {
                  actions.update(node.id, {
                    canvasWidth: dimensions.width,
                    canvasHeight: dimensions.height,
                  });
                }
              }}
            />
          ) : activeKind === "video" && previewUrl ? (
            <video
              ref={videoPreviewRef}
              className="nowheel"
              src={previewUrl}
              draggable={false}
              muted={videoMuted}
              loop
              playsInline
              preload="auto"
              onLoadedMetadata={(event) => {
                const video = event.currentTarget;
                setVideoDuration(Number(video.duration) || 0);
                const dimensions = reconcileMediaNodeDimensions(
                  node,
                  video.videoWidth,
                  video.videoHeight,
                );
                if (dimensions) {
                  actions.update(node.id, {
                    canvasWidth: dimensions.width,
                    canvasHeight: dimensions.height,
                  });
                }
              }}
              onLoadedData={(event) => {
                const video = event.currentTarget;
                if (video.paused && video.currentTime === 0 && video.duration > 0) {
                  video.currentTime = Math.min(1 / 30, Math.max(0, video.duration - 0.04));
                }
              }}
              onDurationChange={(event) => setVideoDuration(Number(event.currentTarget.duration) || 0)}
              onTimeUpdate={(event) => setVideoTime(event.currentTarget.currentTime)}
              onPlay={() => setVideoPlaying(true)}
              onPause={() => setVideoPlaying(false)}
              onError={() => {
                if (!bufferedPreview) retryBufferedPreview();
              }}
            />
          ) : activeKind === "audio" && previewUrl ? (
            <GenerationAudioPreview
              src={previewUrl}
              filePath={String(selectedOutput?.filePath || uploaded?.filePath || uploaded?.path || "")}
              fileName={String(selectedOutput?.fileName || uploaded?.name || node.title || "audio.m4a")}
              onError={() => {
                if (!bufferedPreview) retryBufferedPreview();
              }}
            />
          ) : (
            <div className="work-empty-state">
              <IconSymbol className="work-empty-type-icon" name={metaIcon} />
            </div>
          )}
          <GenerationNodeImageOverlays
            node={node}
            actions={actions}
            activeKind={activeKind}
            activeFilePath={activeFilePath}
            previewUrl={previewUrl}
            imageWidth={imageSize.width}
            imageHeight={imageSize.height}
            semanticZoom={semanticZoom}
            anchorRef={annotationAnchorRef}
            imageCropOpen={imageCropOpen}
            onImageCropClose={onImageCropClose}
            imageAnnotationOpen={imageAnnotationOpen}
            onImageAnnotationClose={onImageAnnotationClose}
          />
          {activeKind === "video" && previewUrl && (
            <div className="work-video-status">
              <span>{formatMediaTime(videoTime)} / {formatMediaTime(videoDuration)}</span>
            </div>
          )}
          {activeKind === "video" && previewUrl && (
            <div
              className="work-video-controls nodrag nopan"
              onPointerDown={(event) => event.stopPropagation()}
            >
              <button
                type="button"
                className="work-video-control-button"
                title={videoPlaying ? "暂停" : "播放"}
                aria-label={videoPlaying ? "暂停视频" : "播放视频"}
                onClick={(event) => {
                  event.stopPropagation();
                  const video = videoPreviewRef.current;
                  if (!video) return;
                  if (video.paused) void video.play().catch(() => undefined);
                  else video.pause();
                }}
              >
                <IconSymbol name={videoPlaying ? "pause" : "play"} />
              </button>
              <span className="work-video-controls-time">
                {formatMediaTime(videoTime)} / {formatMediaTime(videoDuration)}
              </span>
              <div className="work-video-controls-spacer" />
              <button
                type="button"
                className="work-video-control-button"
                title={videoMuted ? "开启声音" : "关闭声音"}
                aria-pressed={!videoMuted}
                onClick={(event) => {
                  event.stopPropagation();
                  const nextMuted = !videoMuted;
                  setVideoMuted(nextMuted);
                  if (videoPreviewRef.current) videoPreviewRef.current.muted = nextMuted;
                }}
              >
                <IconSymbol name={videoMuted ? "volume-x" : "volume"} />
              </button>
              <button
                type="button"
                className="work-video-control-button"
                title="全屏预览"
                aria-label="全屏预览"
                onClick={(event) => {
                  event.stopPropagation();
                  const video = videoPreviewRef.current;
                  if (video?.requestFullscreen) void video.requestFullscreen().catch(() => undefined);
                }}
              >
                <IconSymbol name="maximize" />
              </button>
              <button
                type="button"
                className="work-video-progress"
                aria-label="调整视频进度"
                onClick={(event) => {
                  event.stopPropagation();
                  const video = videoPreviewRef.current;
                  if (!video || !(videoDuration > 0)) return;
                  const bounds = event.currentTarget.getBoundingClientRect();
                  video.currentTime = Math.max(0, Math.min(videoDuration, (event.clientX - bounds.left) / bounds.width * videoDuration));
                  setVideoTime(video.currentTime);
                }}
              >
                <span style={{ width: `${videoDuration > 0 ? Math.min(100, videoTime / videoDuration * 100) : 0}%` }} />
              </button>
            </div>
          )}
          {!imageCropOpen && (activeKind === "image" || activeKind === "video") && previewUrl && (
            <button
              type="button"
              className="work-preview-download nodrag nopan"
              title="另存原始文件"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                void saveActiveMedia();
              }}
            >
              <IconSymbol name="download" />
            </button>
          )}
          {!imageCropOpen && outputs.length > 1 && (
            <div className="generation-output-dots">
              {outputs.map((output) => (
                <button
                  key={output.id}
                  className={output === selectedOutput ? "active" : ""}
                  title={output.title}
                  onClick={(e) => {
                    e.stopPropagation();
                    actions.selectOutput(node.id, output.id);
                  }}
                />
              ))}
            </div>
          )}
        </div>
        {node.status === "running" && (
          <div className="work-progress">
            <span style={{ width: `${Number(node.progress) || 0}%` }} />
          </div>
        )}
        {Boolean(node.error) && (
          <div className="work-error" title={String(node.error)}>{String(node.error)}</div>
        )}
      </div>
    </div>
  );
}
