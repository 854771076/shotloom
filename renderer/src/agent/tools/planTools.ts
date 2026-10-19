import { store, touchProject } from '@/store/projectStore';
import { isPlanMode, setPlanMode, type ProjectState } from '@/services/agentConversations';
import { registerAgentTool } from '../core/toolRegistry';

/**
 * 计划模式的收尾工具：让 Agent 把只读调研与规划得到的方案交回用户裁决。
 *
 * 计划模式只改提示词引导、不裁剪任何工具（见 services/agentConversations 的项目级 planMode 契约），
 * 因此"什么时候从规划转入执行"必须是一次明确的人工确认，而不是代码去阻塞其它写工具。exit_plan_mode
 * 用 approvalRequired 声明这一步永远先请用户拍板：批准即退出计划模式、放行后续写入与生成；
 * 拒绝则保持计划模式，让 Agent 继续打磨方案。effect 如实记为 agent_state_write——它只翻项目级开关，
 * 不动画布、不启动生成。
 */
function currentProject(): ProjectState {
  return store.project as ProjectState;
}

export function registerPlanTools(): void {
  registerAgentTool({
    id: 'exit_plan_mode',
    icon: 'list',
    title: '结束规划并开始执行',
    description: '在计划模式下完成只读调研、并已在回复中给出可执行的 Production Plan 后调用：把这份方案交给用户确认是否转入执行。必须先让用户看清计划（阶段、工作项、依赖、将产出的素材），不要用这句调用代替计划本身。用户批准后会退出计划模式并放行写入与生成；用户拒绝则保持计划模式，继续细化方案。',
    effect: 'agent_state_write',
    approvalRequired: true,
    inputSchema: {
      type: 'object',
      required: ['summary'],
      properties: {
        summary: { type: 'string', description: '一句话概括将要执行的核心计划，供用户在确认卡上核对' },
      },
      additionalProperties: false,
    },
    summarizeInput: (input) => String(input.summary || '').slice(0, 120),
    execute: () => {
      const project = currentProject();
      if (!isPlanMode(project)) {
        return { success: false, error: '当前不在计划模式，无需退出。请直接按用户需求执行。' };
      }
      setPlanMode(project, false);
      touchProject({ sessionDelay: 250, coalesceSession: true });
      return {
        success: true,
        planMode: false,
        note: '用户已批准计划并退出计划模式。现在可以创建/配置节点并启动生成，按 Production Plan 逐项执行并如实核验产出。',
      };
    },
  });
}
