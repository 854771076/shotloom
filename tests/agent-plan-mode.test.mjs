/**
 * 计划模式是"项目级开关 + 一个必须经用户确认的收尾工具"，不是代码去阻塞所有写工具。
 * 这里加载真实模块验证注册行为：exit_plan_mode 永远先请用户拍板（approvalRequired），
 * 只翻项目级 planMode、不动画布；可见性只给三个主 Agent；提示词只在开启时给出引导。
 */
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { createRendererEnv } from './helpers/rendererSsr.mjs';

let env;
let registry;
let conversations;
let projectStore;
let normalization;
let createAgentRunFacts;

const PRIMARIES = ['canvas-primary', 'editor-primary', 'text-primary'];
const SUBAGENTS = ['production-planner', 'stage-executor', 'result-reviewer'];

function contextFor(agentId) {
  return {
    requestId: 'test', turnId: 'turn', projectKey: 'project', conversationId: 'conversation',
    agentId,
    signal: new AbortController().signal,
    loadedSkillIds: new Set(), attachments: [],
    capabilities: { nodeExecution: true }, run: createAgentRunFacts(), state: new Map(), emit: () => {},
  };
}

function planTool() {
  return registry.allAgentTools().find((tool) => tool.id === 'exit_plan_mode');
}

before(async () => {
  env = await createRendererEnv({ storage: new Map(), withWindow: true });
  registry = await env.load('agent/core/toolRegistry');
  conversations = await env.load('services/agentConversations');
  projectStore = await env.load('store/projectStore');
  normalization = await env.load('store/projectNormalization');
  ({ createAgentRunFacts } = await env.load('agent/core/runFacts'));
  const { registerPlanTools } = await env.load('agent/tools/planTools');
  registerPlanTools();
  projectStore.store.project = normalization.createProject('计划模式测试项目');
});

after(async () => {
  await env?.dispose();
});

test('exit_plan_mode 真实注册为需人工确认的项目级开关工具', () => {
  const definition = planTool();
  assert.ok(definition, 'exit_plan_mode 必须真实注册');
  assert.equal(definition.approvalRequired, true, '退出计划模式必须先经用户确认');
  assert.equal(definition.effect, 'agent_state_write', '它只翻项目级开关，不动画布、不启动生成');
});

test('exit_plan_mode 只在计划模式内退出，非计划模式返回可恢复回执', () => {
  const project = projectStore.store.project;
  const definition = planTool();

  conversations.setPlanMode(project, false);
  const blocked = definition.execute({}, contextFor('canvas-primary'));
  assert.equal(blocked.success, false);
  assert.match(blocked.error, /当前不在计划模式/);
  assert.equal(conversations.isPlanMode(project), false, '非计划模式调用不该改动开关');

  conversations.setPlanMode(project, true);
  const exited = definition.execute({}, contextFor('canvas-primary'));
  assert.equal(exited.success, true);
  assert.equal(exited.planMode, false);
  assert.equal(conversations.isPlanMode(project), false, '批准后必须真的退出计划模式');
});

test('exit_plan_mode 只授予三个主 Agent，子 Agent 一律不可见', () => {
  for (const id of PRIMARIES) {
    assert.ok(
      registry.listAgentTools(contextFor(id)).some((tool) => tool.id === 'exit_plan_mode'),
      `${id} 运行时应能退出计划模式`,
    );
  }
  for (const id of SUBAGENTS) {
    assert.ok(
      !registry.listAgentTools(contextFor(id)).some((tool) => tool.id === 'exit_plan_mode'),
      `${id} 不该有退出计划模式的权限`,
    );
  }
});

test('计划模式引导只在开启时注入提示词', async () => {
  const { buildPlanModeContext } = await env.load('agent/content/instructions');
  assert.equal(buildPlanModeContext(false), '');
  assert.equal(buildPlanModeContext(undefined), '');
  const guidance = buildPlanModeContext(true);
  assert.match(guidance, /计划模式/);
  assert.match(guidance, /exit_plan_mode/);
  assert.match(guidance, /不裁剪你能调用的工具/, '引导必须说明计划模式不裁剪工具，而非靠代码阻塞写工具');
});
