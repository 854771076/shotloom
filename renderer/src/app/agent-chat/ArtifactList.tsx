import { useState, type DragEvent } from "react";
import { IconSymbol } from "../components/IconSymbol";
import type { WorkflowNodeData } from "../canvas/WorkflowCanvas";
import {
  artifactsForMessage,
  ARTIFACT_DRAG_TYPE,
  type AgentArtifact,
  type AgentArtifactRefs,
} from "./artifactHelpers";
import type { AgentController } from "./contracts";
import { MediaThumb } from "./MediaThumb";
import styles from "./ArtifactList.module.css";

// 产物是本轮的真实交付，不需要一条"本轮产物"标题去宣告它；两列铺开，
// 超过四个先收起来，展开入口用数量说话（照搬参考实现的交付面板折叠方式）。
const COLLAPSED_COUNT = 4;

export function ArtifactList({
  refs,
  nodes,
  controller,
}: {
  refs?: AgentArtifactRefs | undefined;
  nodes: WorkflowNodeData[];
  controller: AgentController;
}) {
  const [expanded, setExpanded] = useState(false);
  const artifacts = artifactsForMessage(refs, nodes);
  if (!artifacts.length) return null;
  const collapsible = artifacts.length > COLLAPSED_COUNT;
  const shown = collapsible && !expanded ? artifacts.slice(0, COLLAPSED_COUNT) : artifacts;
  return (
    <section className={styles.section} aria-label="本轮产物">
      <div className={styles.grid} data-single={artifacts.length === 1 || undefined}>
        {shown.map((artifact) => (
          <ArtifactCard key={artifact.nodeId} artifact={artifact} onFocus={controller.focusNodes} />
        ))}
      </div>
      {collapsible && (
        <button
          type="button"
          className={styles.toggle}
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          <span>{expanded ? "收起" : `全部 ${artifacts.length} 个产物`}</span>
          <IconSymbol name={expanded ? "chevron-up" : "chevron-down"} />
        </button>
      )}
    </section>
  );
}

function ArtifactCard({
  artifact,
  onFocus,
}: {
  artifact: AgentArtifact;
  onFocus: (nodeIds: string[]) => void;
}) {
  const media = artifact.kind === "image" || artifact.kind === "video";
  const canDrag =
    artifact.kind !== "node" && Boolean(artifact.path || artifact.fallbackUrl || artifact.excerpt);

  return (
    <div
      className={styles.card}
      draggable={canDrag}
      onDragStart={(event: DragEvent<HTMLDivElement>) => {
        if (!canDrag) return;
        event.dataTransfer.setData(ARTIFACT_DRAG_TYPE, artifact.nodeId);
        event.dataTransfer.effectAllowed = "copy";
      }}
      title={canDrag ? "拖到画布，添加此产物" : artifact.title}
    >
      <MediaThumb
        kind={artifact.kind}
        path={artifact.path}
        fallbackUrl={artifact.fallbackUrl}
        label={artifact.title}
        fallback={
          artifact.kind === "text" && artifact.excerpt ? (
            <span className={styles.excerpt}>{artifact.excerpt}</span>
          ) : undefined
        }
        onActivate={media ? undefined : () => onFocus([artifact.focusNodeId])}
      />
      <button
        type="button"
        className={styles.locate}
        onClick={() => onFocus([artifact.focusNodeId])}
        aria-label={`在画布中定位：${artifact.title}`}
        title="在画布中定位"
      >
        <IconSymbol name="maximize" />
      </button>
    </div>
  );
}
