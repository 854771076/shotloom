import { useEffect, useRef, useState } from "react";
import { IconSymbol } from "../components/IconSymbol";
import type { AgentController, AgentGoalView } from "./contracts";
import styles from "./GoalBar.module.css";

/**
 * 目标条：项目级长期目标在界面上的唯一可见处，固定在输入卡片上方的停靠区。
 *
 * 它只读 `agentPanelData` 递来的那一份规范目标，改写一律经 controller.runCommand 的 CAS 动词；
 * 面板不再自己维护第二套目标结构，也不再往会话里回显"已设定长期目标"之类的文本。
 * 目标完成或被清除后整条收起——那时它已经不再是当前事实。
 */
export function GoalBar({
  goal,
  armed,
  busy,
  conversationId,
  model,
  controller,
}: {
  goal: AgentGoalView | null;
  armed: boolean;
  busy: boolean;
  conversationId: string;
  model: string;
  controller: AgentController;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const input = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setEditing(false);
    setError("");
  }, [goal?.id, goal?.revision]);

  useEffect(() => {
    if (editing) input.current?.focus();
  }, [editing]);

  if (!goal || goal.phase === "complete") return null;

  const run = (command: Parameters<AgentController["runCommand"]>[0]) => {
    if (inFlight.current) return;
    inFlight.current = true;
    const result = controller.runCommand(command, { conversationId, model });
    inFlight.current = false;
    setError(result.error || "");
  };

  // 进行中但驱动已停用（用户停止或上一轮失败）与真的暂停呈现为同一件事：都不会自己往下跑。
  const paused = goal.phase !== "active" || !armed;
  const label = goal.phase === "blocked" ? "受阻的目标" : paused ? "已暂停的目标" : "进行中的目标";
  const rounds = `${goal.roundsStarted}/${goal.maxGoalRounds}`;

  if (editing) {
    const save = () => {
      const objective = draft.trim();
      if (!objective) return;
      run({ kind: "goal", action: "set", objective });
      if (!error) setEditing(false);
    };
    return (
      <form
        className={styles.bar}
        data-tone={goal.phase === "blocked" ? "blocked" : undefined}
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <input
          ref={input}
          className={styles.editor}
          value={draft}
          maxLength={2000}
          aria-label="目标内容"
          placeholder="目标内容"
          onChange={(event) => {
            setDraft(event.target.value);
            setError("");
          }}
        />
        <button type="button" className={styles.icon} title="保存" aria-label="保存" disabled={!draft.trim()} onClick={save}>
          <IconSymbol name="check" />
        </button>
        <button
          type="button"
          className={styles.icon}
          title="取消"
          aria-label="取消"
          onClick={() => {
            setEditing(false);
            setError("");
          }}
        >
          <IconSymbol name="x" />
        </button>
      </form>
    );
  }

  return (
    <div
      className={styles.bar}
      data-tone={goal.phase === "blocked" ? "blocked" : undefined}
      title={goal.phase === "blocked" && goal.blockedReason ? `受阻原因：${goal.blockedReason}` : goal.objective}
    >
      <IconSymbol name="task" className={styles.glyph} />
      <span className={styles.label}>{label}</span>
      {error ? (
        <span className={styles.error} role="status">{error}</span>
      ) : (
        <span className={styles.objective}>{goal.objective}</span>
      )}
      <span className={styles.rounds}>{rounds}</span>
      <span className={styles.actions}>
        {goal.phase === "active" && armed ? (
          <IconAction label="暂停目标" icon="pause" disabled={busy} onClick={() => run({ kind: "goal", action: "pause" })} />
        ) : (
          <IconAction
            label={goal.phase === "active" ? "继续自动续行" : "恢复目标"}
            icon="play"
            onClick={() =>
              goal.phase === "active"
                ? controller.goalDrive({ conversationId, model })
                : run({ kind: "goal", action: "resume" })
            }
          />
        )}
        <IconAction
          label="编辑目标"
          icon="pencil"
          onClick={() => {
            setDraft(goal.objective);
            setError("");
            setEditing(true);
          }}
        />
        <IconAction label="清除目标" icon="trash" disabled={busy} onClick={() => run({ kind: "goal", action: "clear" })} />
      </span>
    </div>
  );
}

function IconAction({
  label,
  icon,
  disabled,
  onClick,
}: {
  label: string;
  icon: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" className={styles.icon} title={label} aria-label={label} disabled={disabled} onClick={onClick}>
      <IconSymbol name={icon} />
    </button>
  );
}
