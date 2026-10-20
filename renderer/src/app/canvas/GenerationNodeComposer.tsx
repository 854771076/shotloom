import { useState, type RefObject } from "react";
import { getGenerationInputModes, getModelInfo, getModelSchema } from "../../domain/catalog/ModelCatalog";
import { compileGenerationNodeConfig } from "../../domain/graph/GenerationNodeContract";
import { DEFAULT_CAMERA_CONFIG } from "../../utils/cameraConfig.ts";
import { IMAGE_STYLE_PRESETS } from "../../utils/imageStylePresets.ts";
import { modelDescription, optionLabel, paramPresentation } from "../../utils/modelPresentation.ts";
import { openMediaViewer } from "../store/overlayStore";
import { IconSymbol } from "../components/IconSymbol";
import { ProviderBrandIcon } from "../components/ProviderBrandIcon";
import { CameraControlPanel } from "./CameraControlPanel";
import { GenerationSettingsPanel } from "./GenerationSettingsPanel";
import { isImeKeyEvent, useImeCommit } from "./imeComposition";
import { generationMediaKind, useGenerationLocalPreview } from "./generationNodeMedia";
import { generationModelIcon, toGenerationConfigParam, type GenerationNodeState, type GenerationSchemaParam } from "./generationNodeState";
import type { WorkflowIncomingInput, WorkflowNodeActions, WorkflowNodeData } from "./WorkflowCanvas";

function generationInputLabel(input: WorkflowIncomingInput) {
  return input.inputSlot === "firstFrame"
    ? "首帧" : input.inputSlot === "lastFrame" ? "尾帧"
      : input.inputSlot === "inputVideo" ? "参考视频" : input.inputSlot === "referenceAudio" ? "参考音频" : "参考";
}

/** 底栏摘要只把布尔参数翻译成产品语义，不重复参数标题。 */
function booleanParamSummary(key: string, label: string, value: unknown) {
  if (/audio/i.test(key) || label.includes("声音") || label.includes("有声")) return value ? "有声" : "无声";
  if (/watermark/i.test(key) || label.includes("水印")) return value ? "水印" : "无水印";
  return value ? label : "关闭";
}

/** 滑杆的值是裸数字（"1"、"10"），在摘要里看不出是哪项参数，所以带上参数名；其余值本身可读。 */
function paramSummary(param: GenerationSchemaParam, value: unknown) {
  if (param.type === "boolean") return booleanParamSummary(param.key, param.label, value);
  const text = optionLabel(param, value);
  return paramPresentation(param).control === "slider" ? `${param.label} ${text}` : text;
}

function ComposerInputThumbnail({
  input,
  onRemove,
  label,
}: {
  input: WorkflowIncomingInput;
  onRemove: () => void;
  label?: string;
}) {
  const kind = generationMediaKind(input);
  const { url } = useGenerationLocalPreview(input, kind, 1);
  const previewable = (kind === "image" || kind === "video") && Boolean(url);
  const openInputPreview = () => {
    if (!previewable) return;
    openMediaViewer({
      src: url,
      kind,
      title: input.name || (kind === "image" ? "参考图片" : "参考视频"),
      filePath: String(input.filePath || input.path || ""),
    });
  };
  return (
    <div className="work-composer-input" title={input.name}>
      <button
        type="button"
        className="work-composer-input-preview"
        title={previewable ? `放大预览：${input.name}` : input.name}
        aria-label={previewable ? `放大预览 ${input.name}` : input.name}
        disabled={!previewable}
        onClick={openInputPreview}
      >
        {kind === "image" && url ? (
          <img src={url} alt={input.name} />
        ) : kind === "video" && url ? (
          <video src={url} muted playsInline preload="metadata" />
        ) : (
          <IconSymbol name={kind === "audio" ? "waveform" : kind === "text" ? "text" : "file"} />
        )}
        {label && <span className="work-composer-input-label">{label}</span>}
      </button>
      <button className="work-composer-input-remove" type="button" title="移除参考素材" onClick={onRemove}>
        <IconSymbol name="x" />
      </button>
    </div>
  );
}

export function GenerationNodeComposer({
  node,
  state,
  actions,
  promptRef,
}: {
  node: WorkflowNodeData;
  state: GenerationNodeState;
  actions: WorkflowNodeActions;
  promptRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const [openMenu, setOpenMenu] = useState("");
  const promptCommit = useImeCommit<HTMLTextAreaElement>(String(node.prompt || ""), (value) =>
    actions.update(node.id, { prompt: value }),
  );
  const {
    activeCameraConfig, activeInputMode, busy, cameraControlEnabled, config, fixedImageSlots,
    kind, mediaInputs, models, selectedModel, selectedPreset, summaryParams,
  } = state;

  function setConfig(key: string, value: unknown) {
    actions.update(node.id, { config: { ...config, [key]: value } });
  }

  return (
    <div
      className="work-composer nodrag nopan nowheel"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="work-composer-row">
        {node.type === "imageGeneration" && selectedPreset && (
          <div className="preset-picker">
            <button
              className="preset-trigger"
              type="button"
              onClick={() => setOpenMenu(openMenu === "preset" ? "" : "preset")}
            >
              <span className="preset-icon" style={{ color: selectedPreset.tone }}>
                <IconSymbol name={selectedPreset.icon} />
              </span>
              <span>{selectedPreset.label}</span>
              <IconSymbol name="chevron-down" />
            </button>
            {openMenu === "preset" && (
              <div className="preset-menu">
                <div className="preset-menu-scroll">
                  {IMAGE_STYLE_PRESETS.map((preset) => (
                    <button
                      key={preset.id || "none"}
                      type="button"
                      className={`preset-option${preset.id === selectedPreset.id ? " active" : ""}`}
                      onClick={() => {
                        const next = { ...config };
                        if (preset.id) next.stylePresetId = preset.id;
                        else delete next.stylePresetId;
                        actions.update(node.id, { config: next });
                        setOpenMenu("");
                      }}
                    >
                      <span className="preset-icon" style={{ color: preset.tone }}>
                        <IconSymbol name={preset.icon} />
                      </span>
                      <span>
                        <strong>{preset.label}</strong>
                        <em>{preset.description}</em>
                      </span>
                      {preset.id === selectedPreset.id && <IconSymbol name="check" />}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      <div className="work-prompt-shell">
        <div className="work-composer-inputs">
          {fixedImageSlots.length ? fixedImageSlots.map((slot) => {
            const input = mediaInputs.find((item) => item.inputSlot === slot);
            return input ? (
              <ComposerInputThumbnail
                key={slot}
                input={input}
                label={slot === "firstFrame" ? "首帧" : "尾帧"}
                onRemove={() => actions.removeIncomingEdge(node.id, input.edgeId)}
              />
            ) : (
              <button
                key={slot}
                type="button"
                className="work-composer-add work-composer-slot nodrag nopan"
                title={`添加${slot === "firstFrame" ? "首帧" : "尾帧"}`}
                onClick={() => void actions.addReference(node.id, slot)}
              >
                <IconSymbol name="plus" />
                <span>{slot === "firstFrame" ? "首帧" : "尾帧"}</span>
              </button>
            );
          }) : mediaInputs.map((input) => (
            <ComposerInputThumbnail
              key={input.edgeId}
              input={input}
              label={generationInputLabel(input)}
              onRemove={() => actions.removeIncomingEdge(node.id, input.edgeId)}
            />
          ))}
          {!fixedImageSlots.length && activeInputMode && mediaInputs.length < (activeInputMode.maxImages + activeInputMode.maxVideos + activeInputMode.maxAudios) && (
            <button
              type="button"
              className="work-composer-add nodrag nopan"
              title="添加参考素材"
              onClick={() => void actions.addReference(node.id)}
            >
              <IconSymbol name="plus" />
            </button>
          )}
        </div>
        <textarea
          ref={promptRef}
          placeholder={kind === "text"
            ? "输入给大模型的文本生成提示词"
            : kind === "audio"
              ? "输入要朗读的文本"
              : "描述你想生成的画面或视频"}
          rows={2}
          {...promptCommit}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !isImeKeyEvent(e.nativeEvent)) {
              e.preventDefault();
              actions.run(node.id);
            }
          }}
        />
      </div>
      <div className="work-param-row">
        <div className="work-param-controls">
        <div className="work-model-picker">
          <button
            className="work-model-trigger"
            type="button"
            title="选择生成模型"
            onClick={() => setOpenMenu(openMenu === "model" ? "" : "model")}
          >
            <ProviderBrandIcon className="model-logo" icon={generationModelIcon(selectedModel)} />
            <span>{getModelInfo(selectedModel)?.name || selectedModel || "选择模型"}</span>
            <IconSymbol name="chevron-down" />
          </button>
          {openMenu === "model" && (
            <div className="model-menu">
              <p>选择生成模型</p>
              {models.length ? (
                models.map((model) => (
                  <button
                    key={model}
                    type="button"
                    className={`model-option${model === selectedModel ? " active" : ""}`}
                    onClick={() => {
                      actions.update(node.id, {
                        model,
                        config: compileGenerationNodeConfig(
                          config,
                          getModelSchema(node.type, model).params.map(toGenerationConfigParam),
                          node.outputSpec,
                        ),
                        status: "idle",
                        progress: 0,
                        error: "",
                      });
                      const nextMode = getGenerationInputModes(model)[0];
                      if (nextMode) actions.setInputMode(node.id, nextMode.value);
                      setOpenMenu("");
                    }}
                  >
                    <ProviderBrandIcon className="model-logo" icon={generationModelIcon(model)} />
                    <span className="model-copy">
                      <strong>{getModelInfo(model)?.name || model}</strong>
                      <em>{String(modelDescription(model, node.type))}</em>
                    </span>
                    {model === selectedModel && <IconSymbol name="check" />}
                  </button>
                ))
              ) : (
                <div className="model-menu-empty">暂无可用模型</div>
              )}
            </div>
          )}
        </div>
        <div className="generation-settings-picker">
          <button
            type="button"
            className={`generation-settings-trigger${openMenu === "generationSettings" ? " active" : ""}`}
            title="生成参数"
            onClick={() => setOpenMenu(openMenu === "generationSettings" ? "" : "generationSettings")}
          >
            {activeInputMode && <span>{activeInputMode.label}</span>}
            {summaryParams.slice(0, 4).map((param) => (
              <span key={param.key}>
                {paramSummary(param, config[param.key] ?? param.default)}
              </span>
            ))}
            <IconSymbol name="chevron-down" />
          </button>
          {openMenu === "generationSettings" && (
            <GenerationSettingsPanel
              nodeId={node.id}
              state={state}
              actions={actions}
              onConfigChange={setConfig}
            />
          )}
        </div>
        {node.type === "imageGeneration" && (
          <button
            type="button"
            className={`work-camera-btn${cameraControlEnabled ? " active" : ""}`}
            title={
              cameraControlEnabled
                ? `${activeCameraConfig.camera} · ${activeCameraConfig.lens} · ${activeCameraConfig.focalLength} · ${activeCameraConfig.aperture}`
                : "打开摄影机配置"
            }
            onClick={() => {
              const opening = openMenu !== "camera";
              setOpenMenu(opening ? "camera" : "");
              if (opening && !cameraControlEnabled) {
                actions.update(node.id, {
                  config: {
                    ...config,
                    cameraControl: true,
                    cameraConfig: { ...activeCameraConfig },
                  },
                });
              }
            }}
          >
            <IconSymbol name="camera" />
            <span>{cameraControlEnabled ? activeCameraConfig.focalLength : "镜头"}</span>
          </button>
        )}
        </div>
        <button
          className={`work-run-btn${busy ? " running" : ""}`}
          disabled={busy}
          title={busy ? "正在生成" : "开始生成"}
          onClick={() => actions.run(node.id)}
        >
          <IconSymbol name={busy ? "refresh" : "send"} />
        </button>
      </div>
      {node.type === "imageGeneration" && openMenu === "camera" && (
        <CameraControlPanel
          config={activeCameraConfig}
          enabled={cameraControlEnabled}
          onChange={(value) =>
            actions.update(node.id, {
              config: { ...config, cameraControl: true, cameraConfig: value },
            })
          }
          onToggle={(enabled) =>
            actions.update(node.id, {
              config: {
                ...config,
                cameraControl: enabled,
                cameraConfig: config.cameraConfig || { ...DEFAULT_CAMERA_CONFIG },
              },
            })
          }
          onClose={() => setOpenMenu("")}
        />
      )}
    </div>
  );
}
