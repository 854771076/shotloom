/**
 * 审批瀑布的服务层契约：`'never'` 就地判定（不靠监听器排序）、回合边界前置检查、
 * 审计对完整、答者失败一律失败关闭。这些都是权限与安全边界，必须失败关闭而不是静默放行。
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRendererEnv } from './helpers/rendererSsr.mjs';

const storage = new Map();
let env;
let waterfall;
let settingsStore;
let projectStore;
let normalization;
let identity;
let interactions;
let originalPolicy;
let sequence = 0;

before(async () => {
  env = await createRendererEnv({ storage, withWindow: true });
  waterfall = await env.load('agent/runtime/approvalWaterfall');
  settingsStore = await env.load('store/settingsStore');
  projectStore = await env.load('store/projectStore');
  normalization = await env.load('store/projectNormalization');
  identity = await env.load('services/agentProjectIdentity');
  interactions = await env.load('agent/runtime/runtimeInteractions');
  projectStore.store.project = normalization.createProject('审批测试项目');
  originalPolicy = settingsStore.settingsStore.agentApprovalPolicy;
});

after(async () => {
  settingsStore.settingsStore.agentApprovalPolicy = originalPolicy;
  await env?.dispose();
});

function makeContext() {
  const requestId = `run-${(sequence += 1)}`;
  return {
    requestId,
    turnId: `${requestId}:root`,
    projectKey: identity.getAgentProjectKey(),
    conversationId: 'conversation-1',
    state: new Map(),
    signal: new AbortController().signal,
    emit: () => {},
  };
}

function prompt(context, extra = {}) {
  return {
    context,
    continuation: {},
    stepId: 'step-1',
    toolCallId: 'call-1',
    toolName: 'canvas_create_node',
    title: '画布操作',
    actionCount: 1,
    mode: 'decision',
    ...extra,
  };
}

test('回合边界帮助函数：开启/闭合幂等，闭合后不再是开启回合', () => {
  const context = makeContext();
  assert.equal(waterfall.hasOpenAgentTurn(context), false);
  waterfall.openAgentTurn(context, 1);
  assert.equal(waterfall.hasOpenAgentTurn(context), true);
  waterfall.openAgentTurn(context, 1);
  assert.equal(waterfall.hasOpenAgentTurn(context), true);
  waterfall.closeAgentTurn(context);
  assert.equal(waterfall.hasOpenAgentTurn(context), false);
  waterfall.closeAgentTurn(context);
  assert.equal(waterfall.hasOpenAgentTurn(context), false);
});

test("never 策略在服务层就地拒绝：不派发确认，但审计对完整", async () => {
  settingsStore.settingsStore.agentApprovalPolicy = 'never';
  const context = makeContext();
  const events = [];
  context.emit = (event) => events.push(event);
  waterfall.openAgentTurn(context, 1);

  const result = await waterfall.requestApproval(prompt(context));

  assert.equal(result.outcome, 'rejected');
  assert.equal(result.resolution, null);
  assert.equal(events.some((event) => event.type === 'interaction_requested'), false, 'never 不得派发确认卡');
  const asked = events.find((event) => event.type === 'approval_asked');
  const decided = events.find((event) => event.type === 'approval_decided');
  assert.ok(asked && decided, '发送前拒绝也必须写完整审计对');
  assert.equal(asked.policy, 'never');
  assert.equal(decided.outcome, 'rejected');
  settingsStore.settingsStore.agentApprovalPolicy = originalPolicy;
});

test('没有开启回合时失败关闭，且不写半截审计对', async () => {
  settingsStore.settingsStore.agentApprovalPolicy = 'ask';
  const context = makeContext();
  const events = [];
  context.emit = (event) => events.push(event);

  const result = await waterfall.requestApproval(prompt(context));

  assert.equal(result.outcome, 'unavailable');
  assert.equal(events.length, 0, '回合前置检查失败时不得写任何审计事件');
});

test('ask 策略正常批准走 allowed-once，审计与确认事件都落在同一回合', async () => {
  settingsStore.settingsStore.agentApprovalPolicy = 'ask';
  const context = makeContext();
  const events = [];
  context.emit = (event) => events.push(event);
  waterfall.openAgentTurn(context, 2);

  // requestApproval 在第一次 await 前同步登记等待方，因此这里可以立即裁决。
  const promise = waterfall.requestApproval(prompt(context));
  interactions.submitAgentApproval(context.requestId, 'step-1', { approved: true });
  const result = await promise;

  assert.equal(result.outcome, 'allowed-once');
  assert.equal(result.resolution.approved, true);
  assert.equal(result.reason, '');
  const requested = events.find((event) => event.type === 'interaction_requested');
  assert.equal(requested.kind, 'tool_confirmation');
  assert.equal(events.find((event) => event.type === 'interaction_resolved').approved, true);
  assert.equal(events.find((event) => event.type === 'approval_decided').outcome, 'allowed-once');
});

test('用户拒绝走 rejected，拒绝原因回给调用方', async () => {
  settingsStore.settingsStore.agentApprovalPolicy = 'ask';
  const context = makeContext();
  waterfall.openAgentTurn(context, 1);
  const promise = waterfall.requestApproval(prompt(context));
  interactions.submitAgentApproval(context.requestId, 'step-1', { approved: false, error: '用户拒绝了这次画布改动' });
  const result = await promise;

  assert.equal(result.outcome, 'rejected');
  assert.match(result.reason, /用户拒绝了这次画布改动/);
});

test('答者失败（过期/异常）失败关闭，绝不静默放行', async () => {
  settingsStore.settingsStore.agentApprovalPolicy = 'ask';
  const context = makeContext();
  waterfall.openAgentTurn(context, 1);
  const promise = waterfall.requestApproval(prompt(context));
  interactions.expirePendingAgentApproval(context.requestId, 'step-1');
  const result = await promise;

  assert.equal(result.outcome, 'unavailable');
  assert.match(result.reason, /失败关闭/);
});

test('step 模式的批准回执携带工具步骤结果，拒绝则回执失败', async () => {
  settingsStore.settingsStore.agentApprovalPolicy = 'ask';
  const context = makeContext();
  waterfall.openAgentTurn(context, 1);
  const promise = waterfall.requestApproval(prompt(context, { mode: 'step', stepId: 'step-9' }));
  interactions.submitAgentApproval(context.requestId, 'step-9', { approved: true, result: { success: true, applied: 2 } });
  const result = await promise;

  assert.equal(result.outcome, 'allowed-once');
  assert.deepEqual(result.resolution.result, { success: true, applied: 2 });
});
