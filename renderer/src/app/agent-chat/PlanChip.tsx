import { useState } from "react";
import { IconSymbol } from "../components/IconSymbol";
import { showToast } from "../../store/notificationStore";
import type { AgentController } from "./contracts";
import styles from "./PlanChip.module.css";

/**
 * 计划模式开关的当前状态：只在计划模式生效时出现，点一下就退出（等价于 `/plan off`）。
 *
 * 状态来自 `agentPanelData` 递来的那一份项目级布尔值，组件自己不乐观更新——
 * 关闭失败时把原因回给用户，而不是把徽标留在原地骗人。
 */
export function PlanChip({
  active,
  busy,
  conversationId,
  model,
  controller,
}: {
  active: boolean;
  busy: boolean;
  conversationId: string;
  model: string;
  controller: AgentController;
}) {
  const [pending, setPending] = useState(false);
  if (!active) return null;
  return (
    <button
      type="button"
      className={styles.chip}
      title="计划模式已开启 — 点击关闭"
      aria-label="计划模式已开启，按下关闭"
      disabled={busy || pending}
      onClick={() => {
        setPending(true);
        const result = controller.runCommand({ kind: "plan", action: "exit" }, { conversationId, model });
        setPending(false);
        if (result.error) showToast(result.error);
      }}
    >
      {/* 静止时是计划图标，悬停换成关闭：这个按钮的语义就是"关掉它"。 */}
      <span className={styles.mark} aria-hidden="true">
        <IconSymbol name="list" className={styles.glyph} />
        <IconSymbol name="x" className={styles.glyph} data-role="close" />
      </span>
      <span className={styles.label}>计划</span>
    </button>
  );
}
