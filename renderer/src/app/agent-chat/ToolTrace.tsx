import { Fragment, useEffect, useMemo, useState } from "react";
import { agentTitle } from "../../agent/agents/definitions";
import { agentToolIcon, agentToolTitle } from "../../agent/core/toolRegistry";
import { useMediaPreviewCache } from "../canvas/useMediaPreviewCache";
import { IconSymbol } from "../components/IconSymbol";
import type { AgentController, AgentSubagentView, AgentToolCall } from "./contracts";
import { headIcon, liveTitle, processTitle, summarizeProcess } from "./processActivity";
import { traceGroups } from "./traceTimeline";
import styles from "./ToolTrace.module.css";

// 只有运行时合成的行（技能/模板/系统）由界面决定图标；
// 真实工具的图标跟着工具声明走，新增工具不会退回统一的扳手。
const kindIcon: Record<string, string> = {
  skill: "puzzle",
  recipe: "file",
  system: "layers",
};

const statusLabel: Record<string, string> = {
  pending: "等待确认",
  running: "正在运行",
  error: "运行失败",
};

const subagentLabel: Record<string, string> = {
  running: "执行中",
  success: "已完成",
  error: "失败",
};

// 工具名是给模型和运行时用的，界面必须换成注册表里的中文标题，
// 否则新增工具就得在展示层再维护一份名字表。
const toolTitle = (tool: AgentToolCall) =>
  tool.title || agentToolTitle(String(tool.name || "")) || tool.name || "处理步骤";

const toolIcon = (tool: AgentToolCall) =>
  kindIcon[String(tool.kind || "")] || agentToolIcon(String(tool.name || ""));

/**
 * 子 Agent 的显示名。事件没有携带可解析的 agentId 时，
 * 只能显示通用文案，不能挑一个具体 Agent 的名字冒充。
 */
const subagentName = (subagent: AgentSubagentView) =>
  agentTitle(String(subagent.agentId || "")) || "子 Agent";

export function ToolTrace({
  tools,
  subagents,
  typing,
  waitingForAnswer,
  controller,
}: {
  tools: AgentToolCall[];
  subagents?: AgentSubagentView[] | undefined;
  typing?: boolean | undefined;
  waitingForAnswer?: boolean | undefined;
  controller: AgentController;
}) {
  const hasPending = tools.some((tool) => tool.pending);
  const failed = tools.some((tool) => tool.status === "error");
  const [open, setOpen] = useState(false);
  // 待确认和出错的这一组默认展开：用户要看见的是"卡在哪一步、坏在哪一步"，
  // 而不是在折叠行上多读一句状态。其余一律默认收起。
  useEffect(() => setOpen(hasPending || failed), [hasPending, failed]);
  const knownSubagents = subagents || [];
  if ((!tools.length && !knownSubagents.length) || waitingForAnswer) return null;

  // 头部说的是"这一组做了什么"，不是"最后一步是什么"：类别计数、现在时进行中、
  // 收尾时最多三类。失败的说法属于消息级的失败块，不在这里重复一次。
  const summary = summarizeProcess(tools, knownSubagents);
  const settled = !typing && !hasPending;
  const headline = settled ? processTitle(summary) : liveTitle(summary);
  const headlineDetail = settled ? "" : summary.runningDetail;

  return (
    <section
      className={styles.trace}
      data-running={typing || undefined}
      data-open={open}
      data-pending={hasPending || undefined}
    >
      <button
        type="button"
        className={styles.head}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <IconSymbol name={headIcon(summary)} className={styles.headIcon} />
        <span className={styles.headLabel}>
          <span className={styles.headTitle}>{headline}</span>
          {headlineDetail && <span className={styles.headDetail}>{headlineDetail}</span>}
        </span>
        {typing && (
          <span
            className={styles.stop}
            role="button"
            tabIndex={0}
            title="停止 Agent"
            aria-label="停止 Agent"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              controller.cancel();
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              controller.cancel();
            }}
          />
        )}
        <IconSymbol name="chevron-down" className={styles.headChevron} />
      </button>
      {open && (
        <ol className={styles.steps}>
          {traceGroups(tools, knownSubagents).map((group, groupIndex) =>
            group.subagent ? (
              <li
                key={group.subagent.id || `branch-${groupIndex}`}
                className={styles.branch}
                data-status={group.subagent.status || "running"}
              >
                <SubagentLine subagent={group.subagent} />
                {!!group.tools.length && (
                  <ol className={styles.branchSteps}>
                    {group.tools.map((tool, index) => (
                      <StepLine key={tool.id || `tool-${groupIndex}-${index}`} tool={tool} controller={controller} />
                    ))}
                  </ol>
                )}
              </li>
            ) : (
              <Fragment key={`main-${groupIndex}`}>
                {group.tools.map((tool, index) => (
                  <StepLine key={tool.id || `tool-${groupIndex}-${index}`} tool={tool} controller={controller} />
                ))}
              </Fragment>
            ),
          )}
        </ol>
      )}
    </section>
  );
}

const hasArgs = (args: Record<string, unknown> | undefined) =>
  !!args && Object.keys(args).length > 0;

// 结果的首行是失败行的可读摘要；整段回执留在展开体里。
const firstLine = (text: string | undefined) =>
  String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean) || "";

// 参数只在展开时序列化一次；解析异常的回执不能让整条轨迹崩掉。
const formatArgs = (args: Record<string, unknown>) => {
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return "";
  }
};

const formatDuration = (startedAt?: string, endedAt?: string) => {
  if (!startedAt || !endedAt) return "";
  const ms = Date.parse(endedAt) - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};

/**
 * 摘要行是一等公民：状态 + 标题 + 入参摘要一眼可读，超长部分截断——参考实现的行尾不留
 * 一列耗时数字，15 行 "0.0s" 只会把列表压成一片灰。耗时收进步骤自己的展开体。
 * 完整参数与产出同样在展开体里；待确认行已有可编辑的参数编辑器，不再叠加只读展开体。
 */
function StepLine({ tool, controller }: { tool: AgentToolCall; controller: AgentController }) {
  const status = tool.pending ? "pending" : tool.status || "success";
  const previews = (tool.previews || []).filter((item) => item.path);
  const [expanded, setExpanded] = useState(false);
  const argsText = hasArgs(tool.args) ? formatArgs(tool.args as Record<string, unknown>) : "";
  const duration =
    status === "success" || status === "error" ? formatDuration(tool.startedAt, tool.endedAt) : "";
  const expandable = !tool.pending && (!!argsText || !!tool.output || !!previews.length);
  // 完成态不需要状态词：一行本身就是"做了某件事"。只有需要用户行动的三种状态才说话。
  const stateText = statusLabel[status] || "";
  // 失败行把结果的第一行原样顶上摘要位：坏在哪句话，收起时就能看见。
  const summaryText =
    status === "error" ? firstLine(tool.output) || tool.summary || "" : tool.summary || "";
  const tooltip = `${stateText ? `${stateText} ` : ""}${toolTitle(tool)} ${summaryText}${duration ? ` · 耗时 ${duration}` : ""}`;
  const rowContent = (
    <>
      <IconSymbol name={toolIcon(tool)} className={styles.stepIcon} />
      <span className={styles.stepDetail}>
        {!!stateText && <span className={styles.stepState}>{stateText}</span>}
        <span className={status === "running" ? `${styles.stepTitle} ${styles.shimmer}` : styles.stepTitle}>
          {toolTitle(tool)}
        </span>
        {!!summaryText && (
          <span className={styles.stepSummary}>{summaryText}</span>
        )}
      </span>
      {expandable && <IconSymbol name="chevron-right" className={styles.stepChevron} />}
    </>
  );
  return (
    <li
      className={styles.step}
      data-status={status}
      data-open={expanded || undefined}
    >
      {expandable ? (
        <button
          type="button"
          className={styles.stepLine}
          title={tooltip}
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {rowContent}
        </button>
      ) : (
        <span className={styles.stepLine} title={tooltip}>
          {rowContent}
        </span>
      )}
      {expanded && (
        <div className={styles.stepBody}>
          {!!duration && <small className={styles.stepMeta}>耗时 {duration}</small>}
          {!!argsText && (
            <div className={styles.ioSection}>
              <small className={styles.ioLabel}>参数</small>
              <pre className={styles.ioCode}>{argsText}</pre>
            </div>
          )}
          {(!!tool.output || !!previews.length) && (
            <div className={styles.ioSection}>
              <small className={styles.ioLabel}>结果</small>
              {!!tool.output && <p className={styles.ioText}>{tool.output}</p>}
              {!!previews.length && (
                <span className={styles.previewRow}>
                  {previews.map((preview) => (
                    <PreviewImage
                      key={preview.path}
                      path={preview.path}
                      alt={`${toolTitle(tool)} ${preview.label}`}
                    />
                  ))}
                </span>
              )}
            </div>
          )}
        </div>
      )}
      {tool.pending && tool.interactionId && (
        <PendingDecision tool={tool} controller={controller} />
      )}
    </li>
  );
}

/** 谁在执行：一行说明被派发的子 Agent、它接到的任务与状态，下面挂它的步骤和结论。 */
function SubagentLine({ subagent }: { subagent: AgentSubagentView }) {
  const status = subagent.status || "running";
  const result = status === "error" ? subagent.error : subagent.summary;
  const task = subagent.task || subagent.title || "";
  return (
    <>
      <div
        className={styles.branchHead}
        title={`${subagentName(subagent)} ${subagentLabel[status] || status} ${task}`}
      >
        <IconSymbol name="workflow" className={styles.branchIcon} />
        <span className={styles.branchState}>{subagentLabel[status] || status}</span>
        <span className={styles.branchDetail}>
          <span className={styles.branchName}>{subagentName(subagent)}</span>
          {task && <span className={styles.branchTask}>{task}</span>}
        </span>
      </div>
      {!!result && <div className={styles.branchResult}>{result}</div>}
    </>
  );
}

/**
 * 工具产出的本地位图缩略图。必须走项目的图片预览缓存（readImagePreview → blob），
 * 不能直接引用 asset 协议：画布上的图片节点也是这条路径，行为才一致。
 */
function PreviewImage({ path, alt }: { path: string; alt: string }) {
  const { url } = useMediaPreviewCache({ path, kind: "image", maxSize: 320 });
  if (!url) return null;
  return <img className={styles.preview} src={url} alt={alt} title={alt} loading="lazy" />;
}

/** 确认不是只有"放行/拒绝"两个选项：允许在批准前直接改参数。 */
function PendingDecision({
  tool,
  controller,
}: {
  tool: AgentToolCall;
  controller: AgentController;
}) {
  const interactionId = String(tool.interactionId || "");
  const original = useMemo(() => JSON.stringify(tool.pendingArgs || {}, null, 2), [tool.pendingArgs]);
  const [draft, setDraft] = useState(original);
  const [editing, setEditing] = useState(false);
  useEffect(() => setDraft(original), [original]);
  if (!interactionId) return null;

  let modifiedArgs: Record<string, unknown> | undefined;
  let parseError = "";
  const text = draft.trim();
  if (text !== original.trim()) {
    if (!text) {
      modifiedArgs = {};
    } else {
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          modifiedArgs = parsed as Record<string, unknown>;
        } else {
          parseError = "参数必须是一个 JSON 对象";
        }
      } catch {
        parseError = "JSON 解析失败，请检查格式";
      }
    }
  }
  const changed = modifiedArgs !== undefined;

  return (
    <div className={styles.decision}>
      {tool.pendingArgs && (
        <div className={styles.args}>
          <button
            type="button"
            className={styles.argsToggle}
            aria-expanded={editing}
            onClick={() => setEditing((value) => !value)}
          >
            <IconSymbol name={editing ? "chevron-up" : "chevron-right"} />
            <span>参数{changed ? "（已修改）" : ""}</span>
          </button>
          {editing && (
            <>
              <textarea
                className={styles.argsEditor}
                value={draft}
                rows={6}
                spellCheck={false}
                aria-label={`修改 ${tool.name || "工具"} 参数`}
                onChange={(event) => setDraft(event.target.value)}
              />
              {parseError ? (
                <small className={styles.argsError}>{parseError}</small>
              ) : (
                changed && (
                  <button type="button" className={styles.argsReset} onClick={() => setDraft(original)}>
                    恢复原参数
                  </button>
                )
              )}
            </>
          )}
        </div>
      )}
      <div className={styles.decisionActions}>
        <button type="button" onClick={() => controller.rejectToolCall({ interactionId })}>
          拒绝
        </button>
        <button
          type="button"
          className={styles.primary}
          disabled={Boolean(parseError)}
          onClick={() =>
            controller.approveToolCall({
              interactionId,
              ...(changed ? { modifiedArgs } : {}),
            })
          }
        >
          {changed ? "按修改执行" : "确认执行"}
        </button>
      </div>
    </div>
  );
}
