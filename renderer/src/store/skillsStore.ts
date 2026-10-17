import { reactive } from '@/store/domainReactivity';
import { desktopApi } from '@/services/desktopApi';
import { getBuiltInSkill } from '@/services/builtInSkills';
import { uid } from '@/utils/format';

// 技能条目来自磁盘 JSON 与内置库；必填字段与 upsertSkill 的规范化输出一致，
// 索引签名容忍磁盘上的历史扩展字段。
type AnyRecord = Record<string, any>;

export interface SkillRecord {
  id: string;
  name: string;
  description: string;
  category: string;
  version: number;
  triggers: { keywords: string[] };
  instructions: string;
  contracts?: string[];
  workflow?: string;
  agentIds?: string[];
  enabled: boolean;
  builtIn?: boolean;
  updatedAt: string;
  [key: string]: unknown;
}

export const skillsStore = reactive({
  storageVersion: 1,
  skills: [] as SkillRecord[],
  selectedSkillId: null as string | null,
});

export async function loadGlobalSkills() {
  const storage = await desktopApi.skills.getGlobal();
  skillsStore.storageVersion = storage.storageVersion || 1;
  skillsStore.skills = Array.isArray(storage.skills) ? storage.skills : [];
  if (!skillsStore.skills.some((skill) => skill.id === skillsStore.selectedSkillId)) {
    skillsStore.selectedSkillId = skillsStore.skills[0]?.id || null;
  }
}

export async function saveGlobalSkills() {
  const snapshot = JSON.parse(JSON.stringify({
    storageVersion: skillsStore.storageVersion,
    skills: skillsStore.skills,
  }));
  const storage = await desktopApi.skills.setGlobal({
    storageVersion: snapshot.storageVersion,
    skills: snapshot.skills,
  });
  skillsStore.storageVersion = storage.storageVersion || 1;
  skillsStore.skills = storage.skills || [];
}

export function createSkillDraft() {
  return {
    id: uid(),
    name: '新技能',
    description: '说明这个技能适用于什么任务，便于 Agent 自动选择。',
    category: 'general',
    version: 1,
    triggers: { keywords: [] },
    instructions: '输入这个技能的领域行为、边界和执行说明。',
    agentIds: ['canvas-primary'],
    enabled: true,
    updatedAt: new Date().toISOString(),
  };
}

export async function updateSkill(skill: SkillRecord, patch: AnyRecord) {
  const builtIn = skill?.builtIn === true;
  Object.assign(skill, patch, { updatedAt: new Date().toISOString() });
  skill.builtIn = builtIn;
  await saveGlobalSkills();
}

export async function upsertSkill(input: AnyRecord) {
  const existing = skillsStore.skills.find((item) => item.id === String(input.id || '').trim());
  const skill = {
    id: String(input.id || '').trim(),
    name: String(input.name || '').trim(),
    description: String(input.description || '').trim(),
    category: String(input.category || 'general').trim(),
    version: Math.max(1, Number(input.version) || 1),
    triggers: {
      keywords: [...new Set((input.triggers?.keywords || []).map((value: unknown) => String(value).trim()).filter(Boolean))] as string[],
    },
    instructions: String(input.instructions || '').trim(),
    ...(Array.isArray(input.contracts) ? { contracts: input.contracts.map(String) as unknown[] as string[] } : {}),
    ...(typeof input.workflow === 'string' ? { workflow: input.workflow } : {}),
    ...(Array.isArray(input.agentIds) ? { agentIds: [...new Set(input.agentIds.map(String).filter(Boolean))] as string[] } : {}),
    enabled: input.enabled !== false,
    builtIn: existing?.builtIn === true,
    updatedAt: new Date().toISOString(),
  };
  if (!/^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/.test(skill.id)) {
    throw new Error('技能 ID 仅允许小写字母、数字和连字符，且首尾不能是连字符');
  }
  if (!skill.name || !skill.description || !skill.instructions) throw new Error('技能名称、用途说明和指令均不能为空');
  const index = skillsStore.skills.findIndex((item) => item.id === skill.id);
  if (index >= 0) skillsStore.skills[index] = skill as SkillRecord;
  else skillsStore.skills.push(skill);
  await saveGlobalSkills();
  return skill;
}

export async function toggleSkill(skillId: string) {
  const skill = skillsStore.skills.find((s) => s.id === skillId);
  if (!skill) return;
  skill.enabled = skill.enabled === false;
  await saveGlobalSkills();
}

export async function deleteSkill(skillId: string) {
  if (skillsStore.skills.find((skill) => skill.id === skillId)?.builtIn) return;
  skillsStore.skills = skillsStore.skills.filter((skill) => skill.id !== skillId);
  if (skillsStore.selectedSkillId === skillId) {
    skillsStore.selectedSkillId = skillsStore.skills[0]?.id || null;
  }
  await saveGlobalSkills();
}

export async function resetSkillToBuiltIn(skillId: string) {
  const original = getBuiltInSkill(skillId);
  const current = skillsStore.skills.find((skill) => skill.id === skillId);
  if (!original || !current) return false;
  const enabled = current.enabled !== false;
  skillsStore.skills[skillsStore.skills.indexOf(current)] = {
    ...JSON.parse(JSON.stringify(original)),
    enabled,
    builtIn: true,
    updatedAt: new Date().toISOString(),
  };
  await saveGlobalSkills();
  return true;
}
