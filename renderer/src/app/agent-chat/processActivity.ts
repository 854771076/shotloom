import { agentToolActivity } from "../../agent/core/toolRegistry.ts";
import type { AgentSubagentView, AgentToolCall } from "./contracts";
import type { AgentToolActivity } from "../../agent/core/types";

/**
 * 轨迹头部的活动类别。子 Agent 派发不是注册表工具，它的类别只在这层由会话视图给出，
 * 其余全部来自工具自己的声明（core/types 的 activity，缺省按 effect 归类）。
 */
export type ProcessActivity = AgentToolActivity | "subagents";

export interface ProcessSummary {
  counts: Array<{ kind: ProcessActivity; count: number }>;
  running?: ProcessActivity;
  runningDetail: string;
}

/**
 * 进行中和收尾各一套说法：中文的活动短语必须自带宾语，否则折叠头部读起来是半句话。
 * `已` 前缀参与下面的"并"合并规则，改动措辞时两边都要看。
 */
const liveLabel: Record<ProcessActivity, string> = {
  inspect: "正在查看画布与资料",
  canvas: "正在修改画布",
  plan: "正在更新计划",
  write: "正在写入内容",
  editor: "正在修改剪辑",
  generate: "正在启动生成",
  skill: "正在加载技能",
  questions: "等待你的操作",
  tools: "正在调用工具",
  subagents: "正在协调子 Agent",
};

const doneLabel: Record<ProcessActivity, string> = {
  inspect: "已查看画布与资料",
  canvas: "修改了画布",
  plan: "更新了计划",
  write: "写了内容",
  editor: "修改了剪辑",
  generate: "启动了生成",
  skill: "已加载技能",
  questions: "向你提出了问题",
  tools: "已调用工具",
  subagents: "已协调子 Agent",
};

const THINKING = { live: "正在分析请求", done: "已完成分析" };

// 类别图标跟着类别走，而不是"当前这一步的工具图标"：头部说的是整组做了什么。
const activityIcon: Record<ProcessActivity, string> = {
  inspect: "search",
  canvas: "workflow",
  plan: "list",
  write: "pencil",
  editor: "scissors",
  generate: "spark",
  skill: "puzzle",
  questions: "chat",
  tools: "wrench",
  subagents: "layers",
};

const SHARED_PREFIX = "已";
const COMMA = "，";
const DETAIL_MAX_GRAPHEMES = 160;
// 入参里"这一步到底在做什么"的字段名，按产品真实契约列出，首个有值的字段即详情。
const DETAIL_KEYS = [
  "title", "objective", "task", "description", "question", "questions", "prompt", "message",
  "content", "name", "alias", "query", "pattern", "url", "path", "node_id", "nodeIds", "action", "status",
];

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function oneLine(value: unknown): string {
  const text = typeof value === "string"
    ? value
    : Array.isArray(value) && value.every((item) => typeof item === "string")
      ? value.join("、")
      : "";
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  const segments: string[] = [];
  for (const { segment } of segmenter.segment(normalized)) {
    if (segments.length === DETAIL_MAX_GRAPHEMES) {
      return `${segments.slice(0, DETAIL_MAX_GRAPHEMES - 1).join("").trimEnd()}…`;
    }
    segments.push(segment);
  }
  return normalized;
}

function questionsDetail(value: unknown): string {
  if (!Array.isArray(value)) return "";
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const detail = oneLine((item as { question?: unknown }).question);
    if (detail) return detail;
  }
  return "";
}

/**
 * 一行任务详情：第一个有值的已知字段，没有就把工具标题顶上。
 * 参数仍在流式到达时不能提前用工具名占位，否则会闪出随后被替换掉的内容。
 */
function toolDetail(tool: AgentToolCall): string {
  const args = tool.args || {};
  for (const key of DETAIL_KEYS) {
    if (!(key in args)) continue;
    const detail = key === "questions" ? questionsDetail(args[key]) : oneLine(args[key]);
    if (detail) return detail;
  }
  return oneLine(tool.summary || tool.title || "");
}

const rowActivity = (tool: AgentToolCall): ProcessActivity => {
  if (tool.pending) return "questions";
  if (tool.kind === "skill" || tool.kind === "recipe") return "skill";
  if (tool.kind === "system") return "tools";
  return agentToolActivity(String(tool.name || ""));
};

const isSettled = (tool: AgentToolCall) =>
  !tool.pending && (tool.status === "success" || tool.status === "error");

/**
 * 按"不同调用数"排类别，并列时保持首次出现顺序；同时给出最新一步的类别与详情。
 * 计数按调用去重，同一个调用在事件里重述不会把类别权重刷高。
 */
export function summarizeProcess(
  tools: AgentToolCall[],
  subagents: AgentSubagentView[] = [],
): ProcessSummary {
  const counts = new Map<ProcessActivity, number>();
  const seen = new Set<string>();
  let running: ProcessActivity | undefined;
  let runningDetail = "";
  let runningSeq = -Infinity;

  const bump = (kind: ProcessActivity) => counts.set(kind, (counts.get(kind) ?? 0) + 1);

  for (const tool of tools) {
    const key = String(tool.id || tool.name || "");
    if (!seen.has(key)) {
      seen.add(key);
      bump(rowActivity(tool));
    }
    const seq = tool.seq || 0;
    if (!isSettled(tool) && seq >= runningSeq) {
      running = rowActivity(tool);
      runningDetail = toolDetail(tool);
      runningSeq = seq;
    }
  }

  for (const subagent of subagents) {
    const key = String(subagent.id || subagent.agentId || "");
    if (!seen.has(key)) {
      seen.add(key);
      bump("subagents");
    }
    const status = subagent.status || "running";
    if (status !== "running") continue;
    const seq = subagent.seq || 0;
    if (seq >= runningSeq) {
      running = "subagents";
      runningDetail = oneLine(subagent.task || subagent.title || "");
      runningSeq = seq;
    }
  }

  return {
    counts: [...counts].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count),
    ...(running ? { running } : {}),
    runningDetail,
  };
}

/**
 * 收尾头部：最多三类，两类用"并"连接并在都带 `已` 前缀时去掉第二个的前缀，
 * 三类用"，"连接，超过三类加"等"。这是折叠态唯一的说法来源。
 */
export function processTitle(summary: ProcessSummary): string {
  const labels = summary.counts.slice(0, 3).map(({ kind }) => doneLabel[kind]);
  const first = labels[0];
  if (first === undefined) return THINKING.done;
  const second = labels[1];
  if (second === undefined) return first;
  const continuation = (label: string) => label.charAt(0).toLowerCase() + label.slice(1);
  if (labels.length === 2) {
    const shared = second.startsWith(SHARED_PREFIX) && first.startsWith(SHARED_PREFIX);
    return `${first}并${continuation(shared ? second.slice(SHARED_PREFIX.length) : second)}`;
  }
  const title = [first, ...labels.slice(1).map(continuation)].join(COMMA);
  return summary.counts.length > 3 ? `${title}等` : title;
}

/** 进行中头部用现在时说法；还没有任何步骤时是分析请求，而不是"调用工具"。 */
export function liveTitle(summary: ProcessSummary): string {
  if (!summary.running) return THINKING.live;
  return liveLabel[summary.running];
}

/** 头部图标说的是"这一组在做什么"：进行中用当前类别，收尾用占比最高的类别。 */
export function headIcon(summary: ProcessSummary): string {
  if (summary.running) return activityIcon[summary.running];
  return activityIcon[summary.counts[0]?.kind ?? "tools"];
}
