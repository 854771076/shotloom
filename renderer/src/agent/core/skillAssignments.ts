import { AGENT_DEFINITIONS } from '../agents/definitions.ts';

const agentLabels: Record<string, string> = {
  'canvas-primary': '画布 Agent',
  'editor-primary': '剪辑 Agent',
  'text-primary': '文本 Agent',
  'production-planner': '制作规划',
  'stage-executor': '阶段执行',
  'result-reviewer': '结果核验',
};

export const configurableSkillAgents = [
  { id: 'canvas-primary', label: '画布 Agent' },
  { id: 'editor-primary', label: '剪辑 Agent' },
  { id: 'text-primary', label: '文本 Agent' },
] as const;

/**
 * 设置页只展示 Agent 定义里的真实 Skill 归属，不另存一份可漂移的权限表。
 * `*` 只对定义它的 Agent 展开为全部 Skill；子 Agent 没有 Skill 白名单时不显示。
 */
export function skillAgentLabels(skillId: string, assignedIds?: string[]): string[] {
  if (Array.isArray(assignedIds) && assignedIds.length) {
    return assignedIds.map((id) => agentLabels[id] || id).filter(Boolean);
  }
  return AGENT_DEFINITIONS
    .filter((agent) => agent.skills.includes('*') || agent.skills.includes(skillId))
    .map((agent) => agentLabels[agent.id] || agent.title)
    .filter(Boolean);
}

