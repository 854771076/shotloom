import { store, touchProject } from '@/store/projectStore';
import {
  readGoal,
  createGoal,
  editGoal,
  pauseGoal,
  resumeGoal,
  completeGoal,
  blockGoal,
  type GoalResult,
  type ProjectState,
} from '@/services/agentConversations';
import { registerAgentTool } from '../core/toolRegistry';
import type { JsonObject, JsonValue } from '../core/types';

/**
 * 模型侧的长期目标工具：让 Agent 自己设定、推进和收尾跨轮目标。
 *
 * 这三个工具与用户 `/goal` 命令共用 services/agentConversations.ts 里同一组项目级 CAS 动词，
 * 因此界面与模型改的是同一份持久状态，不会出现两套数据结构。goal 是项目级：整个项目同时只有一个
 * 进行中的目标。effect 为 read / agent_state_write：既不改画布也不启动生成，所以不打扰用户审批。
 */

// 目标读写直接落在当前打开项目的持久对象上；动词只接收最小 ProjectState 形状。
function currentProject(): ProjectState {
  return store.project as ProjectState;
}

// 目标是项目级持久态：写成功后按会话快照节奏落盘，与其它持久写入保持一致。
function finishGoalMutation(result: GoalResult): JsonObject {
  touchProject({ sessionDelay: 250, coalesceSession: true });
  if (!result.ok) return { success: false, error: result.error };
  return { success: true, goal: result.goal as unknown as JsonValue };
}

export function registerGoalTools(): void {
  registerAgentTool({
    id: 'get_goal',
    icon: 'target',
    title: '读取当前目标',
    description: '读取本项目的长期目标、phase、轮次进度与阻塞原因。开始一项可能跨多轮的工作前调用，判断是否已有进行中的目标需要继续，而不是重复设定。',
    effect: 'read',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    execute: () => ({ success: true, goal: readGoal(currentProject()) }),
  });

  registerAgentTool({
    id: 'create_goal',
    icon: 'target',
    title: '设定长期目标',
    description: '为一个需要横跨多轮、多次重启的完成目标建立持久记录。仅在没有进行中目标时使用；已有目标时先完成、暂停或清除。可选 max_goal_rounds 约束自动续行的轮次上限。',
    effect: 'agent_state_write',
    inputSchema: {
      type: 'object',
      required: ['objective'],
      properties: {
        objective: { type: 'string', description: '要持续追求完成的最终目标，简洁可核验' },
        max_goal_rounds: { type: 'integer', minimum: 1, description: '自动续行的最大轮次，省略则用默认上限' },
      },
      additionalProperties: false,
    },
    summarizeInput: (input) => String(input.objective || '').slice(0, 60),
    execute: (input) => {
      const maxRounds = input.max_goal_rounds === undefined ? undefined : Number(input.max_goal_rounds);
      return finishGoalMutation(createGoal(currentProject(), String(input.objective || ''), maxRounds));
    },
  });

  registerAgentTool({
    id: 'update_goal',
    icon: 'target',
    title: '更新长期目标',
    description: '按 CAS 修改当前目标：edit 改描述或轮次上限，pause/resume 暂停或恢复，complete 声明目标达成，blocked 记录受阻原因。必须携带 get_goal 返回的精确 goal_id 与 revision；陈旧 revision 会被拒绝，收到拒绝后先重新读取再修改。',
    effect: 'agent_state_write',
    inputSchema: {
      type: 'object',
      required: ['goal_id', 'revision', 'action'],
      properties: {
        goal_id: { type: 'string' },
        revision: { type: 'integer', minimum: 1 },
        action: { type: 'string', enum: ['edit', 'pause', 'resume', 'complete', 'blocked'] },
        objective: { type: 'string' },
        max_goal_rounds: { type: 'integer', minimum: 1 },
        blocked_reason: { type: 'string' },
      },
      additionalProperties: false,
    },
    summarizeInput: (input) => String(input.action || ''),
    execute: (input) => {
      const project = currentProject();
      const ref = { id: String(input.goal_id || ''), revision: Number(input.revision) };
      const action = String(input.action || '');
      let result: GoalResult;
      switch (action) {
        case 'edit': {
          const objective = input.objective === undefined ? undefined : String(input.objective);
          const maxRounds = input.max_goal_rounds === undefined ? undefined : Number(input.max_goal_rounds);
          result = editGoal(project, ref, { objective, maxGoalRounds: maxRounds });
          break;
        }
        case 'pause':
          result = pauseGoal(project, ref);
          break;
        case 'resume':
          result = resumeGoal(project, ref);
          break;
        case 'complete':
          result = completeGoal(project, ref);
          break;
        case 'blocked':
          result = blockGoal(project, ref, String(input.blocked_reason || ''));
          break;
        default:
          return { success: false, error: `未知的目标操作：${action || '(空)'}` };
      }
      return finishGoalMutation(result);
    },
  });
}
