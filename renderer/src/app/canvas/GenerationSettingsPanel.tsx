import {
  aspectRatioStyle,
  isAspectRatioParam,
  optionLabel,
  optionValue,
  paramPresentation,
} from "../../utils/modelPresentation.ts";
import type { WorkflowNodeActions } from "./WorkflowCanvas";
import type { GenerationNodeState } from "./generationNodeState";

/**
 * 参数控件的形状只由目录的 presentation 决定：选项少时用分段按钮或选项块，
 * 比例提供方向图形，其余控件在这里统一渲染，底栏只显示摘要。
 */
export function GenerationSettingsPanel({
  nodeId,
  state,
  actions,
  onConfigChange,
}: {
  nodeId: string;
  state: GenerationNodeState;
  actions: WorkflowNodeActions;
  onConfigChange: (key: string, value: unknown) => void;
}) {
  const { activeInputMode, inputModes, params } = state;
  return (
    <div
      className="generation-settings-panel nodrag nopan nowheel"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      {inputModes.length > 1 && (
        <section>
          <p>生成方式</p>
          <div className="generation-settings-segments">
            {inputModes.map((mode) => (
              <button
                key={mode.value}
                type="button"
                className={mode.value === activeInputMode?.value ? "active" : ""}
                onClick={() => actions.setInputMode(nodeId, mode.value)}
              >
                {mode.label}
              </button>
            ))}
          </div>
        </section>
      )}
      {params.map((param, paramIndex) => {
        const current = state.config[param.key] ?? param.default;
        const presentation = paramPresentation(param);
        const control = presentation.control || (param.type === "boolean" ? "toggle" : (param.options || []).length ? "segmented" : param.type === "number" ? "number" : "text");
        const previousGroup = paramIndex > 0 ? String(paramPresentation(params[paramIndex - 1]).group || "") : "";
        const group = String(presentation.group || "");
        const groupHeading = group && group !== previousGroup
          ? <h5 className="generation-settings-group-title">{group}</h5>
          : null;
        if (control === "toggle") {
          return (
            <div className="generation-settings-param" key={param.key}>
              {groupHeading}
              <section>
                <p>{param.label}</p>
                <div className="generation-settings-chips">
                  <button type="button" className={Boolean(current) ? "active" : ""} onClick={() => onConfigChange(param.key, true)}>开启</button>
                  <button type="button" className={!Boolean(current) ? "active" : ""} onClick={() => onConfigChange(param.key, false)}>关闭</button>
                </div>
              </section>
            </div>
          );
        }
        if (control === "slider") {
          const min = Number(presentation.min);
          const max = Number(presentation.max);
          const step = Number(presentation.step) || 1;
          const value = Number(current ?? min);
          return (
            <div className="generation-settings-param" key={param.key}>
              {groupHeading}
              <section>
                <p>{param.label}</p>
                <div className="generation-settings-slider">
                  <input
                    className="nodrag nopan"
                    type="range"
                    min={min}
                    max={max}
                    step={step}
                    value={value}
                    onChange={(event) => onConfigChange(param.key, Number(event.target.value))}
                  />
                  <output>{value}{presentation.unit || ""}</output>
                </div>
              </section>
            </div>
          );
        }
        if (control === "select") {
          return (
            <div className="generation-settings-param" key={param.key}>
              {groupHeading}
              <section>
                <p>{param.label}</p>
                <select
                  className="generation-settings-input nodrag nopan"
                  value={String(current ?? "")}
                  onChange={(event) => {
                    const matched = (param.options || []).find((option) => String(optionValue(option)) === event.target.value);
                    onConfigChange(param.key, matched === undefined ? event.target.value : optionValue(matched));
                  }}
                >
                  {(param.options || []).map((option) => {
                    const value = optionValue(option);
                    return <option key={String(value)} value={String(value)}>{optionLabel(param, value)}</option>;
                  })}
                </select>
              </section>
            </div>
          );
        }
        if (!(param.options || []).length) {
          const numeric = control === "number";
          return (
            <div className="generation-settings-param" key={param.key}>
              {groupHeading}
              <section>
                <p>{param.label}</p>
                <input
                  className="generation-settings-input nodrag nopan"
                  type={numeric ? "number" : "text"}
                  min={numeric && Number.isFinite(Number(presentation.min)) ? Number(presentation.min) : undefined}
                  max={numeric && Number.isFinite(Number(presentation.max)) ? Number(presentation.max) : undefined}
                  step={numeric && Number.isFinite(Number(presentation.step)) ? Number(presentation.step) : undefined}
                  value={String(current ?? "")}
                  onChange={(event) => {
                    const value = event.target.value;
                    onConfigChange(param.key, numeric && value !== "" ? Number(value) : undefined);
                  }}
                />
              </section>
            </div>
          );
        }
        return (
          <div className="generation-settings-param" key={param.key}>
            {groupHeading}
            <section>
              <p>{param.label}</p>
              <div className={`generation-settings-options${control === "ratio" || isAspectRatioParam(param) ? " ratios" : ""}`}>
                {(param.options || []).map((option) => {
                  const value = optionValue(option);
                  const active = value === current;
                  return (
                    <button
                      key={String(value)}
                      type="button"
                      className={active ? "active" : ""}
                      onClick={() => onConfigChange(param.key, value)}
                    >
                      {(control === "ratio" || isAspectRatioParam(param)) && (
                        <span className="generation-settings-ratio"><span style={aspectRatioStyle(value)} /></span>
                      )}
                      <span>{optionLabel(param, value)}</span>
                    </button>
                  );
                })}
              </div>
            </section>
          </div>
        );
      })}
    </div>
  );
}
