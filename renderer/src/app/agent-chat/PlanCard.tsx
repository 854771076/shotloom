import { useEffect, useState } from "react";
import { IconSymbol } from "../components/IconSymbol";
import type { AgentController, AgentPlanView, AgentPlanStageView } from "./contracts";
import styles from "./PlanCard.module.css";

const stageStatusLabel: Record<string, string> = {
  pending: "待编排",
  doing: "进行中",
  blocked: "受阻",
  done: "已完成",
};

// 头部只报状态计数，不画进度条：扫一眼就知道计划卡在哪一类状态上。
// 零计数的类别不出现，全完成时就只剩"7 已完成"。
const stageProgress = (stages: NonNullable<AgentPlanView["stages"]>) => {
  const count = (status: string) => stages.filter((stage) => stage.status === status).length;
  const done = count("done");
  const doing = count("doing");
  const blocked = count("blocked");
  const pending = stages.length - done - doing - blocked;
  return [
    done && `${done} 已完成`,
    doing && `${doing} 进行中`,
    blocked && `${blocked} 受阻`,
    pending && `${pending} 待编排`,
  ].filter(Boolean).join(" · ");
};

const stageStatusName = (stage: AgentPlanStageView) =>
  stageStatusLabel[String(stage.status || "")] || String(stage.status || "");

export function PlanCard({
  plan,
  controller,
}: {
  plan?: AgentPlanView | undefined;
  controller: AgentController;
}) {
  const stages = plan?.stages || [];
  const [open, setOpen] = useState(false);
  const [expandedStage, setExpandedStage] = useState<string | null>(null);
  useEffect(() => {
    setOpen(false);
    setExpandedStage(null);
  }, [plan?.id]);
  if (!plan || plan.schemaVersion !== 2 || !stages.length) return null;

  const progress = stageProgress(stages);
  // 只规划是这一轮真正需要被看见的例外；默认的执行型计划不必自报家门。
  const planOnly = plan.executionMode !== "execute";

  return (
    <section className={styles.card} data-open={open || undefined}>
      <button
        type="button"
        className={styles.head}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <IconSymbol name="list" className={styles.headIcon} />
        <span className={styles.headTitle} title={planOnly ? `${plan.title || ""} · 仅规划` : undefined}>
          <span className={styles.headName}>{plan.title || plan.goal || "画布制作"}</span>
          {planOnly && <small>仅规划</small>}
        </span>
        <span className={styles.headCount}>{progress}</span>
        <IconSymbol name="chevron-down" className={styles.headChevron} />
      </button>
      {open && (
        <ol className={styles.stages}>
          {stages.map((stage, index) => {
            const key = stage.id || `stage-${index}`;
            const expanded = expandedStage === key;
            const detail = stage.description || stage.workItems?.length || stage.runtimeRefs?.length;
            const stageNodeIds = (stage.runtimeRefs || []).flatMap((ref) =>
              ref.nodeId ? [ref.nodeId] : [],
            );
            const status = stageStatusName(stage);
            return (
              <li key={key} className={styles.stage} data-status={stage.status}>
                <button
                  type="button"
                  className={styles.stageHead}
                  disabled={!detail}
                  aria-expanded={expanded}
                  title={stage.title || `阶段 ${index + 1}`}
                  onClick={() => setExpandedStage(expanded ? null : key)}
                >
                  {/* 状态由形状与颜色承载，aria-label 补足文字通道；行尾不再重复一个状态词。 */}
                  <span className={styles.stageMark} role="img" aria-label={status}>
                    {stage.status === "done" ? (
                      <IconSymbol name="check" className={styles.stageGlyph} />
                    ) : stage.status === "blocked" ? (
                      <IconSymbol name="warning" className={styles.stageGlyph} />
                    ) : (
                      <span className={styles.stageDot} />
                    )}
                  </span>
                  <span className={styles.stageTitle}>{stage.title || `阶段 ${index + 1}`}</span>
                  {!!detail && <IconSymbol name="chevron-down" className={styles.stageChevron} />}
                </button>
                {expanded && (
                  <div className={styles.stageBody}>
                    {stage.description && <p>{stage.description}</p>}
                    {stage.status === "pending" && !stage.authored && (
                      <small>阶段大纲 · 尚未编排工作项</small>
                    )}
                    {!!stage.workItems?.length && (
                      <ul className={styles.workItems}>
                        {stage.workItems.map((workItem) => {
                          const runtimeRef = stage.runtimeRefs?.find(
                            (ref) => ref.workItemId === workItem.id,
                          );
                          return (
                            <li key={workItem.id} className={styles.workItem}>
                              <span className={styles.workItemTitle}>{workItem.title}</span>
                              <span className={styles.workItemMeta}>
                                {workItem.outputType || "output"}
                                {runtimeRef?.nodeId || runtimeRef?.taskId ? " · 已绑定产物" : ""}
                              </span>
                              {workItem.prompt && (
                                <span className={styles.workItemPrompt}>{workItem.prompt}</span>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                    {stage.blockedReason && (
                      <small className={styles.blocked}>{stage.blockedReason}</small>
                    )}
                    {!!stage.runtimeRefs?.some((ref) => ref.nodeId) && (
                      <button type="button" onClick={() => controller.focusNodes(stageNodeIds)}>
                        定位画布产物
                      </button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
