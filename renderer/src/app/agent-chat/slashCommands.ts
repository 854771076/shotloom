/**
 * 用户斜杠命令的唯一解析处。
 *
 * 界面候选菜单、提交分发和适配层执行都消费这里的判定，不再在别处各写一份正则。命令本身只改
 * 项目级 goal/plan 持久状态并产出一条本地结果消息。`/goal <目标>` 与 `/goal resume`
 * 在空闲时启动目标 driver；`/plan <正文>` 解析出 deliverText，由界面发送本轮规划请求。
 *
 * 只识别保留命令 id（goal、plan）。以 `/` 开头但不是这两个命令的一律返回 null——那是技能前缀，
 * 交给既有的 `/skill` 流程处理，命令层不越权解释技能。
 */

export type GoalAction = 'status' | 'clear' | 'pause' | 'resume' | 'complete' | 'set';
export type PlanAction = 'status' | 'enter' | 'exit';

export type SlashCommand =
  | { kind: 'goal'; action: GoalAction; objective?: string }
  | { kind: 'plan'; action: PlanAction; deliverText?: string };

export interface SlashCommandItem {
  id: 'goal' | 'plan';
  name: string;
  usage: string;
  description: string;
}

// '/' 候选菜单里命令排在技能之前，让用户先看到工作流开关。
export const SLASH_COMMANDS: SlashCommandItem[] = [
  {
    id: 'goal',
    name: '长期目标',
    usage: '/goal <目标描述>',
    description: '为需要横跨多轮的工作建立持久目标。/goal 查看状态，/goal pause|resume|complete|clear 调整。',
  },
  {
    id: 'plan',
    name: '计划模式',
    usage: '/plan [本轮请求]',
    description: '让 Agent 先只做只读调研与规划，产出计划待你确认。带正文会把正文作为本轮请求发出；/plan exit 退出。',
  },
];

const GOAL_SUBACTIONS: Record<string, GoalAction> = {
  clear: 'clear',
  pause: 'pause',
  resume: 'resume',
  complete: 'complete',
  status: 'status',
};

export function parseSlashCommand(raw: string): SlashCommand | null {
  const trimmed = String(raw || '').trim();
  const match = trimmed.match(/^\/(goal|plan)(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  const name = match[1] as 'goal' | 'plan';
  const arg = (match[2] || '').trim();

  if (name === 'goal') {
    if (!arg) return { kind: 'goal', action: 'status' };
    const sub = GOAL_SUBACTIONS[arg.toLowerCase()];
    if (sub) return { kind: 'goal', action: sub };
    return { kind: 'goal', action: 'set', objective: arg };
  }

  // plan
  if (!arg) return { kind: 'plan', action: 'enter' };
  const lower = arg.toLowerCase();
  if (lower === 'exit' || lower === 'off') return { kind: 'plan', action: 'exit' };
  if (lower === 'status') return { kind: 'plan', action: 'status' };
  return { kind: 'plan', action: 'enter', deliverText: arg };
}

// '/' 候选：query 为空时列出全部命令，否则按 id/名称前缀匹配；命令是封闭集合，不含技能。
export function matchSlashCommands(query: string): SlashCommandItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return SLASH_COMMANDS;
  return SLASH_COMMANDS.filter((item) =>
    `${item.id} ${item.name}`.toLowerCase().includes(q),
  );
}
