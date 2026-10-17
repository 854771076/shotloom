/**
 * 行为测试：用脚本化的模型响应真实驱动自研 Agent loop。
 *
 * 断言的是"模型每步实际看见哪些工具、工具是否真的执行、事件与历史是否一致"，
 * 不检查源码文本。权限、可见性和历史完整性属于必须失败的边界。
 */
import test, { after, before, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRendererEnv } from './helpers/rendererSsr.mjs';

const storage = new Map();
let env;
let runAgentLoop;
let transcript;
let registry;
let interactions;
let skillsStore;
let settingsStore;
let projectStore;
let normalization;
let desktopApi;
let spill;
let projectIdentity;
let modelRequest;
let catalog;
let runFacts;
let originalShellApproval;

before(async () => {
  env = await createRendererEnv({ storage, realTimers: true });
  ({ runAgentLoop } = await env.load('agent/loop/agentLoop'));
  transcript = await env.load('agent/loop/transcript');
  registry = await env.load('agent/core/toolRegistry');
  interactions = await env.load('agent/runtime/runtimeInteractions');
  skillsStore = await env.load('store/skillsStore');
  settingsStore = await env.load('store/settingsStore');
  projectStore = await env.load('store/projectStore');
  normalization = await env.load('store/projectNormalization');
  desktopApi = (await env.load('services/desktopApi')).desktopApi;
  spill = await env.load('agent/loop/toolOutputSpill');
  projectIdentity = await env.load('services/agentProjectIdentity');
  modelRequest = await env.load('agent/loop/modelRequest');
  catalog = await env.load('domain/catalog/ModelCatalog');
  runFacts = await env.load('agent/core/runFacts');
  originalShellApproval = settingsStore.settingsStore.agentShellApproval;
});

after(async () => {
  await env?.dispose();
});

// 用例之间不共享工具注册表：钩子在断言失败或抛异常时照样执行，
// 避免上一个用例注册的工具泄漏成下一个用例的可见集。
beforeEach(() => registry?.clearAgentToolsForTests());
afterEach(() => registry?.clearAgentToolsForTests());

const PLAN = {
  model: 'gpt-agent', upstreamModel: 'upstream-gpt-agent', providerId: 'shotloom',
  endpointPath: '/v1/chat/completions', endpointScope: 'v1', endpointMethod: 'POST',
  headers: { 'x-marker': 'loop' }, auth: { type: 'bearer' },
  requestOptions: { temperature: 0.3 },
  contextLimit: 4_000, outputLimit: 400, timeoutMs: 300_000,
};

function makeContext(agentId = 'canvas-primary', overrides = {}) {
  const identity = projectIdentity.getAgentProjectIdentity();
  const requestId = `run-${Math.random().toString(36).slice(2, 8)}`;
  return {
    requestId,
    turnId: `${requestId}:root`,
    agentSessionId: requestId,
    projectKey: identity.projectKey,
    projectInstanceId: identity.instanceId,
    projectGeneration: identity.generation,
    conversationId: 'conversation-1',
    agentId,
    signal: new AbortController().signal,
    loadedSkillIds: new Set(),
    attachments: [],
    capabilities: { nodeExecution: true },
    run: runFacts.createAgentRunFacts(),
    state: new Map(),
    emit: () => {},
    ...overrides,
  };
}

function defineTool(id, extra = {}) {
  registry.registerAgentTool({
    id, title: id, description: '测试工具', effect: 'read',
    inputSchema: {
      type: 'object',
      properties: { scope: { type: 'string' }, name: { type: 'string' } },
      additionalProperties: false,
    },
    execute: () => ({ success: true }),
    ...extra,
  });
}

/** 按脚本逐步返回模型响应，并记录每次真实发出的请求体。 */
function scriptedModel(steps) {
  const requests = [];
  let index = 0;
  const callModel = async (body, onTextDelta) => {
    requests.push(structuredClone(body));
    const step = steps[index];
    index += 1;
    if (!step) throw new Error(`脚本只有 ${steps.length} 步，模型却发起了第 ${index} 次请求`);
    if (step.error) throw step.error;
    for (const delta of step.deltas || []) onTextDelta(delta);
    const toolCalls = (step.toolCalls || []).map((call, position) => ({
      id: call.id || `call-${index}-${position}`,
      type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.args || {}) },
    }));
    return {
      text: step.text || '',
      toolCalls,
      finishReason: step.finishReason || (toolCalls.length ? 'tool_calls' : 'stop'),
      usage: step.usage,
    };
  };
  return { callModel, requests };
}

function toolNames(body) {
  return (body.tools || []).map((tool) => tool.function.name);
}

function toolMessage(messages, toolCallId) {
  const message = messages.find((item) => item.role === 'tool' && item.tool_call_id === toolCallId);
  return String(message?.content ?? '');
}

function toolContent(messages, toolCallId) {
  const message = messages.find((item) => item.role === 'tool' && item.tool_call_id === toolCallId);
  return message ? JSON.parse(message.content) : undefined;
}

function run(input) {
  // 只有一个事件出口：循环内部把 context.emit 指向它自己派生的那个（见 runAgentLoop），
  // 测试不得替它接线，否则循环漏掉这一步时测试仍然会通过。
  return runAgentLoop({ plan: PLAN, systemPrompt: 'SYSTEM', messages: [], emit: () => {}, ...input });
}

test('模型只看见本 Agent 白名单内的工具，无工具调用才结束本轮', async () => {
  const executed = [];
  defineTool('canvas_list_nodes', { execute: (input) => { executed.push(input); return { success: true, nodeIds: ['n1'] }; } });
  defineTool('canvas_create_node', { effect: 'canvas_write', execute: () => ({ success: true, nodeId: 'n2' }) });
  defineTool('tool_no_agent_grants_it', { execute: () => ({ success: true }) });

  const context = makeContext();
  const script = scriptedModel([
    { deltas: ['正在查看'], toolCalls: [{ id: 'call-1', name: 'canvas_list_nodes', args: { scope: 'all' } }] },
    { text: '画布上有 1 个节点' },
  ]);
  const events = [];
  const result = await run({
    context,
    callModel: script.callModel,
    emit: (event) => events.push(event),
    messages: [{ role: 'user', content: '看看画布' }],
  });

  assert.equal(result.reply, '画布上有 1 个节点');
  assert.equal(result.modelRounds, 2);
  assert.deepEqual(executed, [{ scope: 'all' }], '工具必须用模型给的参数真实执行一次');

  const firstNames = toolNames(script.requests[0]);
  assert.ok(firstNames.includes('canvas_list_nodes'));
  assert.ok(firstNames.includes('canvas_create_node'), '白名单内的写工具仍会进入请求，权限在执行时把关');
  assert.ok(!firstNames.includes('tool_no_agent_grants_it'), '未授予的工具不得出现在模型请求里');
  assert.equal(script.requests[0].model, PLAN.upstreamModel);
  assert.equal(script.requests[0].__endpointPath, PLAN.endpointPath);
  assert.equal(script.requests[0].temperature, 0.3, '目录声明的 requestOptions 必须原样送出');

  assert.deepEqual(result.messages.map((message) => message.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.equal(toolContent(result.messages, 'call-1').nodeIds[0], 'n1');
  assert.equal(toolContent(result.messages, 'call-1').toolCallId, 'call-1', '模型必须拿到可复述的 toolCallId');
  assert.notEqual(context.run.hasAppliedActions, true, '只读工具不构成项目改动');

  const types = events.map((event) => event.type);
  assert.deepEqual(types.filter((type) => type === 'turn_start').length, 2);
  assert.ok(types.includes('tool_start') && types.includes('tool_end'));
  assert.ok(types.indexOf('turn_start') < types.indexOf('tool_start'), '工具事件在模型给出调用之后');
  assert.ok(types.indexOf('tool_start') < types.indexOf('tool_end'));
  assert.ok(types.indexOf('tool_end') < types.lastIndexOf('turn_start'), '工具结果回写后才有下一轮');
});

test('工具失败作为结果回到模型，不终止本轮运行', async () => {
  defineTool('canvas_list_nodes', { execute: () => ({ success: false, error: '目标节点不存在' }) });
  const context = makeContext();
  const script = scriptedModel([
    { toolCalls: [{ id: 'call-1', name: 'canvas_list_nodes' }] },
    { text: '我改用列表重新定位' },
  ]);
  const events = [];
  const result = await run({ context, callModel: script.callModel, emit: (event) => events.push(event), messages: [{ role: 'user', content: '查看节点' }] });

  assert.equal(toolContent(result.messages, 'call-1').success, false);
  assert.equal(result.reply, '我改用列表重新定位');
  const end = events.find((event) => event.type === 'tool_end');
  assert.equal(end.isError, true);
  assert.equal(context.state.get('lastActionError'), '目标节点不存在');
});

test('工具有各自的执行时限，超时回执只说真实的影响范围', async () => {
  let releaseWrite = null;
  defineTool('canvas_list_nodes', {
    timeoutMs: 3_000,
    execute: async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { success: true, nodeIds: [] };
    },
  });
  defineTool('canvas_create_node', {
    effect: 'canvas_write',
    timeoutMs: 300,
    execute: () => new Promise((resolve) => { releaseWrite = () => resolve({ success: true, nodeId: 'late-node' }); }),
  });
  const context = makeContext();
  const script = scriptedModel([
    { toolCalls: [{ id: 'slow-read', name: 'canvas_list_nodes' }] },
    { toolCalls: [{ id: 'hang-write', name: 'canvas_create_node' }] },
    { text: '已按真实回执继续' },
  ]);
  const events = [];
  const result = await run({ context, callModel: script.callModel, emit: (event) => events.push(event), messages: [{ role: 'user', content: '建节点' }] });

  assert.equal(toolContent(result.messages, 'slow-read').success, true, '在自己时限内返回的工具不该被判超时');
  const timedOut = toolContent(result.messages, 'hang-write');
  assert.equal(timedOut.success, false);
  assert.equal(timedOut.timedOut, true);
  assert.match(timedOut.error, /结果未知/);
  assert.match(timedOut.error, /不要直接重复这次调用/, '写类工具超时不能说成没有效果');
  assert.equal(context.state.get('lastActionError'), timedOut.error);
  assert.equal(events.filter((event) => event.type === 'tool_end').find((event) => event.toolCallId === 'hang-write').isError, true);
  assert.equal(result.reply, '已按真实回执继续');

  // 被放弃的调用后来才返回：历史已经收敛，它不该再补写任何一条结果，也不该让运行崩溃。
  releaseWrite();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(result.messages.filter((message) => message.tool_call_id === 'hang-write').length, 1);
});

test('同一批只读调用并发派发，任何写调用与动态 effect 都退回串行', async () => {
  let inFlight = 0;
  const inFlightAtStart = {};
  // 每个调用都占用 40 毫秒：并发时后启动的那个会看到在飞数量为 2，串行时永远是 1。
  const busy = (payload) => async (input, toolContext) => {
    inFlight += 1;
    inFlightAtStart[toolContext.turnId] = inFlight;
    await new Promise((resolve) => setTimeout(resolve, 40));
    inFlight -= 1;
    return { success: true, ...payload };
  };
  defineTool('canvas_list_nodes', { execute: busy({ label: 'list' }) });
  defineTool('canvas_get_node', { execute: busy({ label: 'get' }) });
  defineTool('canvas_media_frame', {
    // 权限分类要解析参数才知道，并发决策却必须在执行前做出，因此这类调用不算并行安全。
    resolveEffect: () => 'read',
    execute: busy({ label: 'frame' }),
  });
  defineTool('canvas_create_node', { effect: 'canvas_write', execute: busy({ nodeIds: ['n1'] }) });

  const context = makeContext();
  const script = scriptedModel([
    { toolCalls: [{ id: 'r1', name: 'canvas_list_nodes', args: { scope: 'nodes' } }, { id: 'r2', name: 'canvas_get_node', args: { name: 'A1' } }] },
    { toolCalls: [{ id: 'r3', name: 'canvas_get_node', args: { name: 'B2' } }, { id: 'w1', name: 'canvas_create_node', args: { scope: 'create' } }] },
    { toolCalls: [{ id: 'r4', name: 'canvas_media_frame', args: { name: 'C3' } }, { id: 'r5', name: 'canvas_get_node', args: { name: 'D4' } }] },
    { text: '只读结果已按真实回执合并' },
  ]);
  const result = await run({ context, callModel: script.callModel, messages: [{ role: 'user', content: '先看真实画布' }] });

  const turnPrefix = `${context.requestId}:tool:`;
  assert.equal(Math.max(inFlightAtStart[`${turnPrefix}r1`], inFlightAtStart[`${turnPrefix}r2`]), 2, '整批只读时至少要有一个调用看见同伴还在飞');
  assert.equal(inFlightAtStart[`${turnPrefix}r3`], 1, '同批里有写调用就全部串行');
  assert.equal(inFlightAtStart[`${turnPrefix}w1`], 1);
  assert.equal(inFlightAtStart[`${turnPrefix}r4`], 1, '动态 effect 的调用不能参与并发');
  assert.equal(inFlightAtStart[`${turnPrefix}r5`], 1);

  // 并发的真正风险是共享记账容器互相覆盖：容器只剩一条就说明丢了记账。
  assert.equal(context.run.toolReceipts.size, 6, '每个调用各自的回执都要留下');
  assert.equal(context.run.successfulToolCallIds.size, 6);
  assert.deepEqual([...context.state.get('startedToolCallIds')].sort(), ['r1', 'r2', 'r3', 'r4', 'r5', 'w1']);
  assert.equal(context.run.hasAppliedActions, true, '写调用的真实改动仍照常入账');

  assert.deepEqual(
    result.messages.filter((message) => message.role === 'tool').map((message) => message.tool_call_id),
    ['r1', 'r2', 'r3', 'w1', 'r4', 'r5'],
    '并发只改执行时机，历史里仍按模型给出的顺序对齐',
  );
  assert.equal(toolContent(result.messages, 'r1').label, 'list');
  assert.equal(toolContent(result.messages, 'r2').label, 'get');
  assert.equal(toolContent(result.messages, 'r4').label, 'frame');
  assert.equal(result.reply, '只读结果已按真实回执合并');
});

test('参数校验与权限拒绝都是可恢复回执，并留下失败步骤', async () => {
  let readCalls = 0;
  let generationCalls = 0;
  defineTool('canvas_list_nodes', { execute: () => { readCalls += 1; return { success: true, nodeIds: [] }; } });
  defineTool('canvas_start_generation', {
    effect: 'media_generation',
    execute: () => { generationCalls += 1; return { success: true, taskId: 't1' }; },
  });

  const context = makeContext('canvas-primary', { capabilities: { nodeExecution: false } });
  const events = [];
  const script = scriptedModel([
    { toolCalls: [{ id: 'bad-args', name: 'canvas_list_nodes', args: { unknown_field: 'x' } }] },
    { toolCalls: [{ id: 'no-permission', name: 'canvas_start_generation' }] },
    { toolCalls: [{ id: 'ok-read', name: 'canvas_list_nodes', args: { scope: 'nodes' } }] },
    { text: '已按回执改好参数并换掉不允许的操作' },
  ]);
  const result = await run({
    context, callModel: script.callModel, emit: (event) => events.push(event),
    messages: [{ role: 'user', content: '先看看画布' }],
  });

  const invalid = toolContent(result.messages, 'bad-args');
  assert.equal(invalid.success, false);
  assert.equal(invalid.rejection, 'invalid_input');
  assert.match(invalid.issues.join('；'), /unknown_field is not allowed/, '结构化的校验问题要原样回到模型');
  const denied = toolContent(result.messages, 'no-permission');
  assert.equal(denied.rejection, 'permission');
  assert.match(denied.error, /不允许执行 canvas_start_generation/);

  assert.equal(generationCalls, 0, '权限拒绝必须真的挡住执行');
  assert.equal(readCalls, 1, '只有校验通过的调用才派发');
  // 没派发过的调用不留开始标记，也不该有回执；否则中断补写会把它说成影响未知。
  assert.equal(context.run.toolReceipts.size, 1);
  assert.deepEqual([...context.run.successfulToolCallIds], ['ok-read']);
  assert.deepEqual([...context.state.get('startedToolCallIds')], ['ok-read']);
  assert.notEqual(context.run.hasAppliedActions, true);
  assert.equal(context.state.get('lastActionError'), denied.error);

  const ended = events.filter((event) => event.type === 'tool_end');
  assert.deepEqual(ended.map((event) => event.toolCallId), ['bad-args', 'no-permission', 'ok-read']);
  assert.equal(ended[0].isError, true, '被拒绝的调用要在轨迹里留下失败步骤，而不是凭空消失');
  assert.equal(ended[0].toolName, 'canvas_list_nodes');
  assert.equal(ended[0].rejection, 'invalid_input');
  assert.equal(events.filter((event) => event.type === 'tool_start').length, 1, '没有派发的调用不该显示成正在执行');

  assert.equal(result.reply, '已按回执改好参数并换掉不允许的操作');
});

test('真实改过项目却没提交终态时，只追加一次结论回合', async () => {
  defineTool('canvas_create_node', { effect: 'canvas_write', execute: () => ({ success: true, nodeIds: ['n1'] }) });
  defineTool('report_outcome', {
    effect: 'agent_state_write',
    inputSchema: {
      type: 'object', required: ['status', 'summary', 'evidence'],
      properties: {
        status: { type: 'string' }, summary: { type: 'string' },
        evidence: { type: 'object' }, remaining: { type: 'array', items: { type: 'string' } },
      },
      additionalProperties: false,
    },
    execute: (input, context) => {
      const verified = input.status === 'completed';
      if (verified) context.state.set('verifiedOutcome', input);
      else context.state.set('lastOutcomeIssue', 'evidence 里没有可核验的真实回执');
      return { success: verified, issues: verified ? [] : ['证据不足'] };
    },
  });

  const script = scriptedModel([
    { toolCalls: [{ id: 'w1', name: 'canvas_create_node' }] },
    { text: '已经建好节点' },
    { toolCalls: [{ id: 'o1', name: 'report_outcome', args: { status: 'blocked', summary: '还差配音', evidence: {} } }] },
    { text: '已提交剩余项' },
  ]);
  const result = await run({ context: makeContext(), callModel: script.callModel, messages: [{ role: 'user', content: '建节点' }] });

  assert.equal(result.reply, '已提交剩余项');
  assert.equal(script.requests.length, 4, '一句总结不足以结束，必须多给一次结论回合');
  const asked = script.requests[2].messages.at(-1);
  assert.equal(asked.role, 'user');
  assert.match(asked.content, /report_outcome/, '结论回合要明确指向 report_outcome');
  assert.equal(toolContent(script.requests[3].messages, 'o1').success, false, '被拒绝的终态不能算已核验');
  assert.equal(result.messages.filter((message) => message.role === 'user'
    && String(message.content).includes('report_outcome')).length, 1, '结论回合只追加一次，不反复追问');

  // 没有真实改动项目：解释型回答直接结束，不该被结论回合打扰。
  const chat = scriptedModel([{ text: '分镜先讲人物动机' }]);
  const chatResult = await run({ context: makeContext(), callModel: chat.callModel, messages: [{ role: 'user', content: '讲讲分镜' }] });
  assert.equal(chat.requests.length, 1, '只读回答不该触发终态结论');
  assert.equal(chatResult.reply, '分镜先讲人物动机');

  // 终态已通过核验：之后的一句收尾就是终点。
  const concluded = scriptedModel([
    { toolCalls: [{ id: 'w2', name: 'canvas_create_node' }] },
    { toolCalls: [{ id: 'o2', name: 'report_outcome', args: { status: 'completed', summary: '完成', evidence: { nodeIds: ['n1'] } } }] },
    { text: '已全部完成' },
  ]);
  const concludedResult = await run({ context: makeContext(), callModel: concluded.callModel, messages: [{ role: 'user', content: '建节点并收尾' }] });
  assert.equal(concluded.requests.length, 3, '已提交通过核验的终态就不再追加结论回合');
  assert.equal(concludedResult.reply, '已全部完成');
});

test('Skill 命名空间工具只有在真正加载后才进入下一次请求', async () => {
  defineTool('canvas_list_nodes');
  defineTool('skill_short_drama__inspect_structure');
  skillsStore.skillsStore.skills = [
    { id: 'short-drama', name: '短剧制作', description: '分镜方法', instructions: '先建立人物动机。', enabled: true },
    { id: 'other-skill', name: '未使用', description: '另一个方法', instructions: '不该被加载。', enabled: true },
  ];
  try {
    const context = makeContext();
    const script = scriptedModel([
      { toolCalls: [{ id: 'call-skill', name: 'skill', args: { name: 'short-drama' } }] },
      { toolCalls: [{ id: 'call-namespaced', name: 'skill_short_drama__inspect_structure' }] },
      { text: '按短剧方法完成' },
    ]);
    const events = [];
    const result = await run({ context, callModel: script.callModel, emit: (event) => events.push(event), messages: [{ role: 'user', content: '做短剧' }] });

    assert.ok(!toolNames(script.requests[0]).includes('skill_short_drama__inspect_structure'), '未加载 Skill 时命名空间工具不可见');
    assert.ok(toolNames(script.requests[0]).includes('skill'), '有授予 Skill 才会有 skill 工具');
    assert.ok(toolNames(script.requests[1]).includes('skill_short_drama__inspect_structure'), '加载后下一步就该可见');
    assert.match(JSON.parse(result.messages.find((message) => message.role === 'tool' && message.tool_call_id === 'call-skill').content).content, /先建立人物动机/);
    assert.equal(toolContent(result.messages, 'call-namespaced').success, true);
    const skillEvent = events.find((event) => event.type === 'skill_used');
    assert.equal(skillEvent.skillId, 'short-drama');
    assert.equal(skillEvent.source, 'user');
    assert.deepEqual([...context.loadedSkillIds], ['short-drama'], '已加载 Skill 必须进入本轮可见集');
  } finally {
    skillsStore.skillsStore.skills = [];
  }
});

test('未授予的 Skill 对模型不可见，加载请求直接失败回执', async () => {
  skillsStore.skillsStore.skills = [{ id: 'granted', name: '已授予', description: '用途', instructions: '内容', enabled: true }];
  try {
    const context = makeContext();
    const script = scriptedModel([
      { toolCalls: [{ id: 'call-skill', name: 'skill', args: { name: 'not-granted' } }] },
      { text: '换用可用方法' },
    ]);
    const result = await run({ context, callModel: script.callModel, emit: () => {}, messages: [{ role: 'user', content: '加载别的技能' }] });
    const receipt = JSON.parse(result.messages.find((message) => message.tool_call_id === 'call-skill').content);
    assert.equal(receipt.success, false);
    assert.match(receipt.error, /不在本 Agent 可用列表/);
    assert.equal([...context.loadedSkillIds].length, 0, '失败的加载不得污染可见集');
  } finally {
    skillsStore.skillsStore.skills = [];
  }
});

test('“询问”模式下写工具先请求确认，批准后才真正执行', async () => {
  settingsStore.settingsStore.agentShellApproval = 'ask';
  let executed = 0;
  defineTool('canvas_create_node', { effect: 'canvas_write', execute: () => { executed += 1; return { success: true, nodeIds: ['n1'] }; } });
  const context = makeContext();
  const script = scriptedModel([
    { toolCalls: [{ id: 'call-write', name: 'canvas_create_node' }] },
    { text: '节点已按你的确认创建' },
  ]);
  const events = [];
  const approvalHandler = (event) => {
    if (event.type !== 'interaction_requested') return;
    // 等待方在 emit 之后才注册，所以这里排到下一个宏任务再批准。
    setTimeout(() => interactions.submitAgentApproval(event.requestId || context.requestId, event.stepId, { approved: true }), 0);
  };
  try {
    const result = await run({
      context,
      callModel: script.callModel,
      emit: (event) => { events.push(event); approvalHandler(event); },
      messages: [{ role: 'user', content: '建一个节点' }],
    });
    assert.equal(executed, 1, '批准后必须真实执行一次');
    assert.ok(transcript.startedToolCallIds(context.state).has('call-write'), '真实派发过就必须留下开始执行的标记');
    assert.equal(result.reply, '节点已按你的确认创建');
    const requested = events.find((event) => event.type === 'interaction_requested');
    assert.equal(requested.kind, 'tool_confirmation');
    assert.equal(requested.toolName, 'canvas_create_node');
    assert.equal(events.find((event) => event.type === 'interaction_resolved').approved, true);
    assert.equal(toolContent(result.messages, 'call-write').nodeIds[0], 'n1');
    assert.ok(transcript.startedToolCallIds(context.state).has('call-write'), '真实派发过就必须留下开始执行的标记');
    assert.equal(context.run.hasAppliedActions, true, '只有真实 nodeIds 回执才算画布改动');
  } finally {
    settingsStore.settingsStore.agentShellApproval = originalShellApproval;
  }
});

test('用户拒绝确认后不执行，拒绝原因作为工具结果返回', async () => {
  settingsStore.settingsStore.agentShellApproval = 'ask';
  let executed = 0;
  defineTool('canvas_delete_node', { effect: 'canvas_write', execute: () => { executed += 1; return { success: true }; } });
  const context = makeContext();
  const script = scriptedModel([
    { toolCalls: [{ id: 'call-delete', name: 'canvas_delete_node' }] },
    { text: '已停止删除，改用其他方式' },
  ]);
  const events = [];
  try {
    const result = await run({
      context,
      callModel: script.callModel,
      emit: (event) => {
        events.push(event);
        if (event.type === 'interaction_requested') {
          setTimeout(() => interactions.submitAgentApproval(context.requestId, event.stepId, { approved: false, error: '用户拒绝了删除' }), 0);
        }
      },
      messages: [{ role: 'user', content: '删掉这个节点' }],
    });
    assert.equal(executed, 0, '拒绝后不得执行');
    // 等待确认时被打断的调用没碰过外部世界，所以不能留下"已开始执行"的标记。
    assert.equal(transcript.startedToolCallIds(context.state).has('call-delete'), false);
    assert.match(toolContent(result.messages, 'call-delete').error, /用户拒绝了删除/);
    assert.equal(result.reply, '已停止删除，改用其他方式');
  } finally {
    settingsStore.settingsStore.agentShellApproval = originalShellApproval;
  }
});

test('子 Agent 只使用自己定义里的工具，不继承父 Agent 的画布写权限', async () => {
  defineTool('canvas_list_nodes');
  defineTool('canvas_create_node', { effect: 'canvas_write', execute: () => ({ success: true, nodeId: 'n1' }) });
  defineTool('plan_write', { effect: 'project_write', execute: () => ({ success: true, planId: 'p1' }) });
  skillsStore.skillsStore.skills = [{ id: 'short-drama', name: '短剧制作', description: '分镜方法', instructions: '方法', enabled: true }];
  try {
    const context = makeContext();
    const script = scriptedModel([
      { toolCalls: [{ id: 'call-dispatch', name: 'dispatch_subagent', args: { agentId: 'production-planner', task: '规划三个镜头' } }] },
      { text: '规划完成：三个镜头' },
      { text: '已把规划结果同步给你' },
    ]);
    const events = [];
    const result = await run({ context, callModel: script.callModel, emit: (event) => events.push(event), messages: [{ role: 'user', content: '先规划' }] });

    const parentNames = toolNames(script.requests[0]);
    assert.ok(parentNames.includes('canvas_create_node'));
    assert.ok(parentNames.includes('dispatch_subagent'));
    assert.ok(parentNames.includes('skill'));

    const childNames = toolNames(script.requests[1]);
    assert.ok(childNames.includes('plan_write'), '子 Agent 用自己的白名单');
    assert.ok(!childNames.includes('canvas_create_node'), '规划子 Agent 没有画布写权限');
    assert.ok(!childNames.includes('dispatch_subagent'), '子 Agent 不得再派子 Agent');
    assert.ok(!childNames.includes('skill'), '未授予 Skill 的子 Agent 没有 skill 工具');
    assert.match(script.requests[1].messages[0].content, /Author a Production Plan/, '子 Agent 收到自己的职责说明');
    assert.equal(script.requests[1].messages[1].content, '规划三个镜头');

    assert.equal(toolContent(result.messages, 'call-dispatch').summary, '规划完成：三个镜头');
    assert.ok(transcript.startedToolCallIds(context.state).has('call-dispatch'), '子 Agent 的派发同样要留下开始标记，它的写操作可能已经落地');
    assert.ok(events.some((event) => event.type === 'subagent_started'));
    const completed = events.find((event) => event.type === 'subagent_completed');
    assert.ok(completed.childSessionId.startsWith(`${context.requestId}:sub:production-planner:`));
    assert.equal(result.reply, '已把规划结果同步给你');
  } finally {
    skillsStore.skillsStore.skills = [];
  }
});

test('子 Agent 失败把错误返回给父级，而不是终止整轮', async () => {
  defineTool('canvas_list_nodes');
  const context = makeContext();
  const script = scriptedModel([
    { toolCalls: [{ id: 'call-dispatch', name: 'dispatch_subagent', args: { agentId: 'result-reviewer', task: '核验结果' } }] },
    { error: new Error('模型不可用') },
    { text: '我自己用只读工具核验' },
  ]);
  const events = [];
  const result = await run({ context, callModel: script.callModel, emit: (event) => events.push(event), messages: [{ role: 'user', content: '核验' }] });
  const receipt = toolContent(result.messages, 'call-dispatch');
  assert.equal(receipt.success, false);
  assert.match(receipt.error, /模型不可用/);
  assert.equal(events.find((event) => event.type === 'subagent_failed').error.includes('模型不可用'), true);
  assert.equal(result.reply, '我自己用只读工具核验');
});

test('每条事件都标明执行者：子 Agent 的回执不会算到父级身份上', async () => {
  defineTool('canvas_list_nodes');
  const context = makeContext();
  const script = scriptedModel([
    { toolCalls: [{ id: 'call-dispatch', name: 'dispatch_subagent', args: { agentId: 'production-planner', task: '列出节点' } }] },
    { toolCalls: [{ id: 'call-child', name: 'canvas_list_nodes' }] },
    { text: '子结论：1 个节点' },
    { text: '已合并子结论' },
  ]);
  const events = [];
  const result = await run({ context, callModel: script.callModel, emit: (event) => events.push(event), messages: [{ role: 'user', content: '先派给规划 Agent' }] });

  const started = events.find((event) => event.type === 'subagent_started');
  assert.equal(started.childAgentId, 'production-planner', '被派发的 Agent 用 childAgentId 表示');
  assert.equal(started.agentId, 'canvas-primary', '发出这条事件的那一轮仍是父级');
  assert.equal(started.agentSessionId, context.requestId);
  // 界面要分开显示"谁在执行"和"在做什么"，所以任务原文与结论各自成字段，
  // 不能让展示层从拼接后的标题里反推。
  assert.equal(started.task, '列出节点');

  const childCompleted = events.find((event) => event.type === 'subagent_completed');
  assert.equal(childCompleted.summary, '子结论：1 个节点', '子 Agent 的结论要能被界面直接显示');

  const childToolEnd = events.filter((event) => event.type === 'tool_end' && event.toolCallId === 'call-child')[0];
  assert.equal(childToolEnd.agentId, 'production-planner', '子 Agent 执行的回执归属子 Agent');
  assert.equal(childToolEnd.agentSessionId, started.childSessionId, '事件里的会话标识要与派发时生成的子会话一致');

  const parentTurns = events.filter((event) => event.type === 'turn_start' && event.agentId === 'canvas-primary');
  const childTurns = events.filter((event) => event.type === 'turn_start' && event.agentId === 'production-planner');
  assert.equal(parentTurns.length, 2, '父级在派发前后各发起一次请求');
  assert.equal(childTurns.length, 2, '子 Agent 自己的循环也逐步上报');
  assert.ok(parentTurns.every((event) => event.agentSessionId === context.requestId));
  assert.ok(childTurns.every((event) => event.agentSessionId === started.childSessionId));
  assert.ok(events.every((event) => event.agentId && event.agentSessionId), '不得有无身份的事件落入事件日志');

  assert.equal(toolContent(result.messages, 'call-dispatch').summary, '子结论：1 个节点');
  assert.equal(result.reply, '已合并子结论');
});

test('循环派生的出口就是工具管道的 context.emit，工具内事件带本轮 Agent 身份', async () => {
  defineTool('canvas_list_nodes', {
    execute: (_input, context) => {
      context.emit({ type: 'tool_progress', label: '读取画布' });
      return { success: true, nodeIds: [] };
    },
  });
  const context = makeContext();
  const events = [];
  const script = scriptedModel([
    { toolCalls: [{ id: 'call-list', name: 'canvas_list_nodes' }] },
    { text: '节点已列出' },
  ]);
  const result = await run({
    context,
    callModel: script.callModel,
    messages: [{ role: 'user', content: '列一下节点' }],
    emit: (event) => events.push(event),
  });

  const progress = events.find((event) => event.type === 'tool_progress');
  assert.ok(progress, '工具里发出的事件必须到达本轮唯一出口');
  const toolStart = events.find((event) => event.type === 'tool_start');
  assert.ok(toolStart, '管道自己的工具事件走同一个出口');
  assert.equal(progress.agentId, 'canvas-primary', '出口必须打上这一轮执行者的身份');
  assert.equal(toolStart.agentId, progress.agentId);
  assert.equal(toolStart.agentSessionId, progress.agentSessionId);
  assert.equal(result.reply, '节点已列出');
});

test('子 Agent 的写进入父级运行事实，但它的会话状态与终态结论不替父级交付', async () => {
  defineTool('canvas_list_nodes');
  let childState;
  let childRun;
  defineTool('canvas_create_node', {
    effect: 'canvas_write',
    execute: (_input, ctx) => {
      childState = ctx.state;
      childRun = ctx.run;
      // 子 Agent 在自己的会话里提交结论：它只能结束自己这一轮。
      ctx.state.set('verifiedOutcome', { status: 'completed', summary: '子 Agent 自认为已完成' });
      return { success: true, nodeIds: ['n1'] };
    },
  });
  defineTool('report_outcome', {
    effect: 'agent_state_write',
    inputSchema: {
      type: 'object', required: ['status', 'summary', 'evidence'],
      properties: {
        status: { type: 'string' }, summary: { type: 'string' },
        evidence: { type: 'object' }, remaining: { type: 'array', items: { type: 'string' } },
      },
      additionalProperties: false,
    },
    execute: (_input, ctx) => {
      ctx.state.set('verifiedOutcome', { status: 'completed', summary: '父级自己提交' });
      return { success: true };
    },
  });
  const context = makeContext();
  const script = scriptedModel([
    { toolCalls: [{ id: 'call-dispatch', name: 'dispatch_subagent', args: { agentId: 'stage-executor', task: '建一个节点' } }] },
    { toolCalls: [{ id: 'call-child-write', name: 'canvas_create_node' }] },
    { text: '子结论：节点已建' },
    // 父级只回一句总结：项目被真实改过（改动来自子 Agent）却没提交终态，必须走结论回合。
    { text: '已经建好节点' },
    { toolCalls: [{ id: 'call-outcome', name: 'report_outcome', args: { status: 'completed', summary: '节点已建', evidence: { nodeIds: ['n1'] } } }] },
    { text: '交付完成' },
  ]);
  const result = await run({ context, callModel: script.callModel, messages: [{ role: 'user', content: '建一个节点' }] });

  assert.equal(childRun, context.run, '父子共享同一份运行事实');
  assert.notEqual(childState, context.state, '子 Agent 有自己的一份会话状态');
  assert.equal(context.run.hasAppliedActions, true, '子 Agent 落地的写父级必须看得见');
  assert.equal(String(context.state.get('verifiedOutcome').summary), '父级自己提交', '子 Agent 的结论不得覆盖父级');
  assert.ok(!toolNames(script.requests[1]).includes('report_outcome'), '终态提交权只在父级');

  const concludeTurn = result.messages.filter((message) => message.role === 'user'
    && String(message.content).includes('report_outcome'));
  assert.equal(concludeTurn.length, 1, '子 Agent 提交过结论不能免掉父级的结论回合');
  assert.equal(result.reply, '交付完成');
});

test('长任务不被固定轮次切断：每轮都在推进就一直跑下去', async () => {
  defineTool('canvas_list_nodes');
  const context = makeContext();
  // 曾经这里有一个 80 步上限，第 81 轮无论进行到哪都会被判失败。
  const rounds = 90;
  let round = 0;
  const callModel = async () => {
    round += 1;
    if (round > rounds) {
      return { text: `核对完 ${rounds} 个节点`, toolCalls: [], finishReason: 'stop' };
    }
    return {
      text: '',
      toolCalls: [{
        id: `call-${round}`, type: 'function',
        function: { name: 'canvas_list_nodes', arguments: JSON.stringify({ scope: `node-${round}` }) },
      }],
      finishReason: 'tool_calls',
    };
  };
  const result = await run({ context, callModel, messages: [{ role: 'user', content: '逐个核对节点' }] });
  assert.equal(result.modelRounds, rounds + 1);
  assert.equal(result.reply, `核对完 ${rounds} 个节点`);
});

test('连续只重复已试过的调用且不改动项目时，按无进展停止', async () => {
  defineTool('canvas_list_nodes');
  const context = makeContext();
  // 三个调用轮换着来，LoopGuard 的 5 次窗口拦不住它；此时只有"有没有进展"能判定。
  const cycle = ['first', 'second', 'third'];
  const script = scriptedModel(Array.from({ length: 8 }, (_item, index) => ({
    toolCalls: [{ id: `call-${index}`, name: 'canvas_list_nodes', args: { scope: cycle[index % 3] } }],
  })));
  await assert.rejects(
    run({ context, callModel: script.callModel, messages: [{ role: 'user', content: '继续' }] }),
    /连续 3 轮只重复已经试过的调用[\s\S]*本轮已停止/,
  );
  assert.equal(script.requests.length, 6, '达到无进展上限就必须停，不能继续请求模型');
});

test('真实落到项目上的改动算进展，重复调用也能一直跑下去', async () => {
  defineTool('canvas_list_nodes');
  defineTool('canvas_create_node', { effect: 'canvas_write', execute: () => ({ success: true, createdNodeIds: ['n1'] }) });
  const context = makeContext();
  const script = scriptedModel(Array.from({ length: 9 }, (_item, index) => (
    index % 3 === 2
      ? { toolCalls: [{ id: `call-${index}`, name: 'canvas_create_node' }] }
      : { toolCalls: [{ id: `call-${index}`, name: 'canvas_list_nodes', args: { scope: `s${index % 3}` } }] }
  )));
  // 与上一条用例唯一的差别是每三轮有一次真实建节点：循环不该切断它在推进的任务。
  await assert.rejects(
    run({ context, callModel: script.callModel, messages: [{ role: 'user', content: '继续' }] }),
    /脚本只有 9 步/,
  );
  assert.equal(script.requests.length, 10, '有真实改动就不该触发无进展停止');
});

test('模型返回空响应或本轮被截断时都作为失败上报', async () => {
  const context = makeContext();
  await assert.rejects(
    run({ context, callModel: scriptedModel([{ text: '   ' }]).callModel, emit: () => {}, messages: [{ role: 'user', content: '说点什么' }] }),
    /0 token 空响应/,
  );
  defineTool('canvas_list_nodes');
  await assert.rejects(
    run({
      context,
      callModel: scriptedModel([{ text: '我还没写完', toolCalls: [], finishReason: 'length' }]).callModel,
      emit: () => {},
      messages: [{ role: 'user', content: '继续' }],
    }),
    /输出上限/,
  );
});

test('上下文超预算时整组丢弃旧对话，并且只上报一次压缩事件', async () => {
  const filler = 'x'.repeat(6_000);
  const history = [
    { role: 'user', content: `很早以前的问题 ${filler}` },
    { role: 'assistant', content: `很早以前的回答 ${filler}` },
    { role: 'user', content: '刚才的话题' },
    { role: 'assistant', content: '刚才的回复' },
    { role: 'user', content: '最新问题' },
  ];
  const script = scriptedModel([{ text: '只看到近期历史' }]);
  const events = [];
  let persisted = null;
  const result = await run({
    context: makeContext(),
    plan: { ...PLAN, contextLimit: 1_500, outputLimit: 100 },
    callModel: script.callModel,
    emit: (event) => events.push(event),
    onMessagesChanged: (messages) => { persisted = [...messages]; },
    messages: history,
  });
  const sent = script.requests[0].messages.slice(1);
  assert.ok(!JSON.stringify(sent).includes(filler), '超预算的旧分组不得再送给模型');
  assert.ok(persisted && !JSON.stringify(persisted).includes(filler), '落盘的历史必须收敛到模型真正看到的窗口');
  assert.equal(sent[0].role, 'user');
  assert.equal(sent[sent.length - 1].content, '最新问题');
  assert.equal(events.filter((event) => event.type === 'context_compaction').length, 1);
  assert.equal(events.find((event) => event.type === 'context_compaction').droppedGroups, 2);
  assert.ok(events.find((event) => event.type === 'context_usage').inputBudget > 0);
  assert.equal(result.reply, '只看到近期历史');
});

test('上下文预算要扣掉 system 提示词与工具 schema 的占用', async () => {
  defineTool('canvas_list_nodes');
  const filler = 'x'.repeat(7_000);
  const history = [
    { role: 'user', content: `旧话题 ${filler}` },
    { role: 'user', content: '最新问题' },
  ];

  // 控制组：同样的历史在前缀很短时必须原样发送，压缩只能由前缀挤占预算引起。
  const shortScript = scriptedModel([{ text: 'ok' }]);
  const shortEvents = [];
  await run({
    context: makeContext(), callModel: shortScript.callModel, emit: (event) => shortEvents.push(event),
    systemPrompt: '简短系统提示', messages: [...history],
  });
  assert.ok(shortScript.requests[0].messages.some((message) => String(message.content).includes(filler)),
    '前缀装得下时不该动历史');

  const script = scriptedModel([{ text: 'ok' }]);
  const events = [];
  await run({
    context: makeContext(), callModel: script.callModel, emit: (event) => events.push(event),
    systemPrompt: 'p'.repeat(6_000), messages: [...history],
  });
  const usage = events.find((event) => event.type === 'context_usage');
  const shortUsage = shortEvents.find((event) => event.type === 'context_usage');
  assert.ok(usage.prefixTokens > shortUsage.prefixTokens, 'system 提示词的占用必须计入前缀');
  assert.equal(usage.prefixTokens + usage.transcriptBudget, usage.inputBudget, '历史预算等于输入预算减去前缀');
  const sent = script.requests[0].messages;
  assert.ok(!JSON.stringify(sent).includes(filler), '前缀挤占预算后旧分组必须移出请求');
  assert.equal(sent[0].role, 'system');
  assert.equal(sent[1].role, 'user');
  assert.equal(sent[1].compactionNote, undefined, '压缩说明的本地元数据不得发给 provider');
  assert.equal(sent.at(-1).content, '最新问题');
});

test('压缩保留头部原始目标，反复压缩也只有一条压缩说明', () => {
  const head = { role: 'user', content: '最初的目标：做一支 12 镜头的短片' };
  const middle = (prefix, size) => Array.from({ length: size }, (_, index) => [
    { role: 'assistant', content: null, tool_calls: [{ id: `${prefix}${index}`, type: 'function', function: { name: 'canvas_list_nodes', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: `${prefix}${index}`, content: `${prefix} 第 ${index} 次工具结果：${'y'.repeat(900)}` },
  ]).flat();
  const tail = [{ role: 'user', content: '最新问题' }];
  const history = [head, ...middle('a', 6), ...tail];
  const budget = transcript.estimateMessageTokens(history) - 500;

  const window = transcript.fitTranscript(history, budget);
  const notes = window.messages.filter((message) => message.compactionNote);
  assert.equal(notes.length, 1, '压缩说明只能有一条');
  assert.equal(window.messages[0], notes[0]);
  assert.equal(window.messages[1].content, head.content, '足够小的头部原文要保留');
  assert.equal(window.messages.at(-1).content, '最新问题');
  assert.ok(window.droppedGroups >= 1);
  assert.ok(window.foldedLines >= 1, '被折叠的中段必须留下线索');
  assert.match(notes[0].content, /已调用 canvas_list_nodes/);

  const grown = [...window.messages, ...middle('b', 5), ...tail];
  const second = transcript.fitTranscript(grown, budget - 300);
  const secondNotes = second.messages.filter((message) => message.compactionNote);
  assert.equal(secondNotes.length, 1, '反复压缩后仍然只有一条说明，不嵌套');
  assert.equal(second.messages[0], secondNotes[0]);
  assert.equal(second.messages[1].content, head.content);
  assert.deepEqual(secondNotes[0].compactionLines.slice(0, notes[0].compactionLines.length), notes[0].compactionLines,
    '上一轮折叠的线索必须继承，不能凭空消失');
});

test('历史裁剪保持分组完整，中断历史会被补齐应答', () => {
  const withTools = [
    { role: 'user', content: '第一问' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'canvas_list_nodes', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: '第一答的工具结果' },
    { role: 'user', content: '第二问' },
  ];
  const window = transcript.fitTranscript(withTools, 1);
  assert.equal(window.droppedGroups, 2, '从最旧分组开始丢，但永远保留最后一组');
  assert.equal(window.messages[0].role, 'user');
  assert.ok(!window.messages.some((message) => message.role === 'tool'));

  const dangling = [
    withTools[0],
    { role: 'assistant', content: null, tool_calls: [
      { id: 'c1', type: 'function', function: { name: 'canvas_list_nodes', arguments: '{}' } },
      { id: 'c2', type: 'function', function: { name: 'canvas_get_node', arguments: '{}' } },
    ] },
    { role: 'tool', tool_call_id: 'c1', content: '{"success":true}' },
  ];
  const closed = transcript.closeDanglingToolCalls(dangling, () => '未执行');
  assert.deepEqual(closed.map((message) => message.role), ['user', 'assistant', 'tool', 'tool'], '占位结果紧跟在未应答的 assistant 分组后');
  assert.deepEqual([...new Set(closed.filter((message) => message.role === 'tool').map((message) => message.tool_call_id))].sort(), ['c1', 'c2'], '每个调用都必须有应答');
  assert.equal(closed.find((message) => message.tool_call_id === 'c2').content, '未执行');
  assert.deepEqual(transcript.closeDanglingToolCalls(closed, () => '未执行'), closed, '补齐是幂等的');
});
test('中断补齐按这次调用的真实进度说话，不把已落地的写操作说成没有效果', () => {
  const writeCall = { id: 'w1', type: 'function', function: { name: 'canvas_create_node', arguments: '{}' } };
  const readCall = { id: 'r1', type: 'function', function: { name: 'canvas_list_nodes', arguments: '{}' } };
  const deleteCall = { id: 'd1', type: 'function', function: { name: 'canvas_delete_node', arguments: '{}' } };
  const unknownCall = { id: 'u1', type: 'function', function: { name: 'generation_start', arguments: '{}' } };
  const state = new Map();
  const run = runFacts.createAgentRunFacts({
    toolReceipts: new Map([
      ['w1', { callId: 'w1', toolName: 'canvas_create_node', effect: 'canvas_write', success: true, applied: true, partial: false, skippedCount: 0, nodeIds: ['n1'], edgeIds: [], taskIds: [], error: '' }],
      ['r1', { callId: 'r1', toolName: 'canvas_list_nodes', effect: 'read', success: true, applied: false, partial: false, skippedCount: 0, nodeIds: [], edgeIds: [], taskIds: [], error: '' }],
    ]),
  });
  // deleteCall 只走到等待用户确认，尚未派发；unknownCall 已派发但在中断时没留下回执。
  transcript.markToolCallStarted({ state }, 'u1');
  const noteFor = transcript.interruptedToolNoteFor(run, state, new Set(['gone']));

  assert.match(noteFor(writeCall), /已经执行完成[\s\S]*真实改动了项目/);
  assert.match(noteFor(writeCall), /不要重试这个写操作/);
  assert.match(noteFor(readCall), /已经执行完成，没有改动项目/);
  assert.match(noteFor(unknownCall), /已经开始执行[\s\S]*影响未知/);
  assert.match(noteFor(deleteCall), /尚未开始执行，没有产生任何效果/);
  // 上一次未正常退出的调用没有任何本地记录，不能宣称它没产生效果。
  assert.match(noteFor({ id: 'gone', type: 'function', function: { name: 'canvas_create_node', arguments: '{}' } }),
    /上一次未正常退出的运行[\s\S]*影响未知/);
  for (const call of [writeCall, readCall, unknownCall]) {
    assert.doesNotMatch(noteFor(call), /没有产生任何效果/, '有执行痕迹的调用不得声称无副作用');
  }

  const dangling = [{ role: 'assistant', content: null, tool_calls: [writeCall, deleteCall] }];
  assert.deepEqual([...transcript.danglingToolCallIds(dangling)], ['w1', 'd1']);
  const closed = transcript.closeDanglingToolCalls(dangling, noteFor);
  assert.equal(closed.find((message) => message.tool_call_id === 'w1').content, noteFor(writeCall));
  assert.equal(closed.find((message) => message.tool_call_id === 'd1').content, noteFor(deleteCall));
});

test('超长工具结果落盘后历史只留摘要，模型按 callId 能读回原文', async () => {
  const fullText = JSON.stringify({
    success: true,
    nodes: Array.from({ length: 400 }, (_item, index) => ({ id: `n-${index}`, title: `镜头 ${index}`, prompt: 'x'.repeat(80) })),
  });
  assert.ok(fullText.length > 20_000, '用例必须真的超过落盘阈值');
  // 落盘的是模型本应看到的完整回执，工具管道会在结果上补 callId。
  const spilledText = JSON.stringify({ ...JSON.parse(fullText), toolCallId: 'call-big' });
  defineTool('canvas_list_nodes', { execute: () => JSON.parse(fullText) });
  const project = normalization.createProject('落盘测试项目');
  project.agentConversations = [{ id: 'conversation-1' }];
  const previous = {
    projectDir: projectStore.store.projectDir,
    filePath: projectStore.store.filePath,
    project: projectStore.store.project,
    writeFileToPath: desktopApi.file.writeFileToPath,
    readArrayBuffer: desktopApi.file.readArrayBuffer,
  };
  const files = new Map();
  projectStore.store.project = project;
  projectStore.store.filePath = null;
  projectStore.store.projectDir = '/tmp/shotloom-spill-loop-test';
  desktopApi.file.writeFileToPath = async (filePath, bytes) => {
    files.set(filePath, new TextDecoder().decode(bytes));
    return { filePath };
  };
  desktopApi.file.readArrayBuffer = async (filePath) => new TextEncoder()
    .encode(String(files.get(filePath) ?? '')).buffer;
  const context = makeContext();
  const script = scriptedModel([
    { toolCalls: [{ id: 'call-big', name: 'canvas_list_nodes' }] },
    { text: '已确认落盘并可读回' },
  ]);
  try {
    const result = await run({
      context, callModel: script.callModel, messages: [{ role: 'user', content: '列出全部节点' }],
    });
    const recorded = toolMessage(result.messages, 'call-big');
    assert.ok(recorded.length < spilledText.length, '历史里不能整条塞进超大结果');
    assert.ok(recorded.startsWith('{"success":true'), '摘要必须保留真实头部');
    assert.match(recorded, /中间省略 \d+ 个字符/);
    assert.match(recorded, /read_tool_output[\s\S]*callId="call-big"/);
    assert.equal([...files.keys()].length, 1, '完整结果必须真的落盘一次');
    assert.equal([...files.values()][0], spilledText, '落盘内容必须与工具原始输出逐字一致');
    assert.ok([...files.keys()][0].startsWith('/tmp/shotloom-spill-loop-test/.shotloom/agent-spill/conversation-1__call-big'),
      `落盘位置必须在项目目录内并按会话+callId 命名：${[...files.keys()][0]}`);
    assert.deepEqual(
      project.agentConversations[0].toolOutputs.map((item) => [item.callId, item.chars]),
      [['call-big', spilledText.length]],
      '落盘索引必须随会话持久化，读回只认这份索引',
    );

    const firstPage = await spill.readSpilledToolOutput(context, { callId: 'call-big', limit: 7_000 });
    assert.equal(firstPage.success, true);
    assert.equal(firstPage.eof, false, '一次读取必须能分段继续');

    const reassembled = await readEverythingBack(context, 'call-big');
    assert.equal(reassembled, spilledText, '分段读回拼起来必须与原始输出逐字一致');

    const missing = await spill.readSpilledToolOutput(context, { callId: 'call-other' });
    assert.equal(missing.success, false);
    assert.match(missing.error, /没有 callId 为「call-other」的落盘输出/);
  } finally {
    projectStore.store.projectDir = previous.projectDir;
    projectStore.store.filePath = previous.filePath;
    projectStore.store.project = previous.project;
    desktopApi.file.writeFileToPath = previous.writeFileToPath;
    desktopApi.file.readArrayBuffer = previous.readArrayBuffer;
    // 落盘索引写入会排期一次会话持久化；等它真实跑完再结束测试。
    await new Promise((resolve) => setTimeout(resolve, 320));
  }
});

async function readEverythingBack(context, callId) {
  let text = '';
  let offset = 0;
  for (;;) {
    const page = await spill.readSpilledToolOutput(context, { callId, offset, limit: 7_000 });
    assert.equal(page.success, true, '分段读回不能失败');
    text += page.content;
    offset = page.nextOffset;
    if (page.eof) return text;
  }
}

test('没有磁盘目录时不落盘，摘要必须承认读不回来', async () => {
  const previousDir = projectStore.store.projectDir;
  projectStore.store.projectDir = null;
  try {
    const small = '{"success":true}';
    assert.equal(
      await spill.serializeToolOutputForTranscript({
        context: makeContext(), callId: 'call-small', toolName: 'canvas_get_node', text: small,
      }),
      small,
      '没超阈值的结果必须原样进历史，不产生文件往返',
    );

    const summary = await spill.serializeToolOutputForTranscript({
      context: makeContext(), callId: 'call-big', toolName: 'canvas_list_nodes', text: 'y'.repeat(25_000),
    });
    assert.match(summary, /完整结果未能落盘/);
    assert.doesNotMatch(summary, /read_tool_output/, '没有落盘就不能指向读回工具');
    assert.ok(summary.length < 25_000, '落盘失败时也必须缩减历史体积');
  } finally {
    projectStore.store.projectDir = previousDir;
  }
});

test('运行中到达的补充指令在步骤边界注入历史，且每条只注入一次', async () => {
  defineTool('canvas_list_nodes');
  const pending = [];
  const script = scriptedModel([
    { toolCalls: [{ id: 'call-1', name: 'canvas_list_nodes' }] },
    { toolCalls: [{ id: 'call-2', name: 'canvas_list_nodes' }] },
    { text: '已按补充指令继续' },
  ]);
  // 第一句在工具回执落地时到达，第二句在第二次模型响应之后才到达：都不在注入点之前
  const emit = (event) => {
    if (event.type === 'tool_end' && event.toolCallId === 'call-1') pending.push('尾帧用同一张参考图');
  };
  const callModel = async (body, onTextDelta) => {
    const turn = await script.callModel(body, onTextDelta);
    if (script.requests.length === 2) pending.push('再加一个空镜');
    return turn;
  };
  const result = await run({
    context: makeContext(),
    callModel,
    emit,
    messages: [{ role: 'user', content: '做两个镜头' }],
    takeSteeringMessages: () => pending.splice(0, pending.length),
  });

  assert.equal(result.modelRounds, 3);
  assert.deepEqual(
    result.messages.map((message) => message.role),
    ['user', 'assistant', 'tool', 'user', 'assistant', 'tool', 'user', 'assistant'],
  );
  assert.match(result.messages[3].content, /补充了指令/);
  assert.match(result.messages[3].content, /尾帧用同一张参考图/);
  assert.match(result.messages[6].content, /再加一个空镜/);
  const count = (text) => result.messages.filter(
    (message) => message.role === 'user' && String(message.content).includes(text),
  ).length;
  assert.equal(count('尾帧用同一张参考图'), 1);
  assert.equal(count('再加一个空镜'), 1);
  // 注入必须真的到达模型：第二步看见第一条，第三步看见两条。
  assert.match(JSON.stringify(script.requests[1].messages), /尾帧用同一张参考图/);
  assert.doesNotMatch(JSON.stringify(script.requests[0].messages), /尾帧用同一张参考图/);
  assert.match(JSON.stringify(script.requests[2].messages), /再加一个空镜/);
});

test('收尾文本之后才到达的指令不会被丢弃，而是再走一步', async () => {
  const script = scriptedModel([
    { text: '两个镜头都做完了' },
    { text: '空镜已补上' },
  ]);
  const pending = [];
  let firstRound = true;
  const callModel = async (body, onTextDelta) => {
    // 模型已经决定收尾，这一句在响应返回前才到达
    if (firstRound) {
      firstRound = false;
      pending.push('再补一个空镜');
    }
    return script.callModel(body, onTextDelta);
  };
  const result = await run({
    context: makeContext(),
    callModel,
    messages: [{ role: 'user', content: '做两个镜头' }],
    takeSteeringMessages: () => pending.splice(0, pending.length),
  });

  assert.equal(result.modelRounds, 2, '收尾前有一条指令就必须再走一步');
  assert.equal(result.reply, '空镜已补上');
  assert.deepEqual(result.messages.map((message) => message.role), ['user', 'assistant', 'user', 'assistant']);
  assert.match(result.messages[2].content, /再补一个空镜/);
  assert.match(JSON.stringify(script.requests[1].messages), /再补一个空镜/);
});

test('loop 只驱动目录明确声明的三种 Agent 协议', () => {
  const supported = [];
  const unsupported = [];
  for (const model of catalog.getCatalogModels()) {
    if (!catalog.resolveModelRuntimeContract('textGeneration', model.id, [])) continue;
    (modelRequest.loopUnsupportedReason(model.id) ? unsupported : supported).push(model.id);
  }
  assert.ok(supported.length);
  assert.ok(supported.includes('gpt-5.6'));
  assert.ok(supported.some((id) => id.startsWith('claude-')));
  for (const id of unsupported) assert.match(modelRequest.loopUnsupportedReason(id), /未声明支持|运行时契约|协议声明/);
});

test('Responses 和 Messages 请求保留工具历史并只发送各自协议字段', () => {
  const tools = [{ type: 'function', function: { name: 'lookup', description: '查询', parameters: { type: 'object' } } }];
  const messages = [
    { role: 'system', content: '按事实回答' },
    { role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,YWJj' } }] },
    { role: 'assistant', content: '查询中', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{"id":1}' } }] },
    { role: 'tool', tool_call_id: 'call-1', content: '{"ok":true}' },
  ];
  const responses = modelRequest.buildLoopRequestBody({ ...PLAN, protocol: 'openai-responses' }, tools, messages);
  assert.equal(responses.__agentProtocol, 'openai-responses');
  assert.equal(responses.messages, undefined);
  assert.equal(responses.input[1].content[1].type, 'input_image');
  assert.deepEqual(responses.input.at(-1), { type: 'function_call_output', call_id: 'call-1', output: '{"ok":true}' });
  assert.equal(responses.tools[0].name, 'lookup');

  const anthropic = modelRequest.buildLoopRequestBody({ ...PLAN, protocol: 'anthropic-messages' }, tools, messages);
  assert.equal(anthropic.system, '按事实回答');
  assert.equal(anthropic.input, undefined);
  assert.equal(anthropic.messages[0].content[1].source.media_type, 'image/png');
  assert.deepEqual(anthropic.messages[1].content[1], { type: 'tool_use', id: 'call-1', name: 'lookup', input: { id: 1 } });
  assert.equal(anthropic.messages[2].content[0].tool_use_id, 'call-1');
  assert.equal(anthropic.tools[0].input_schema.type, 'object');

  const chat = modelRequest.buildLoopRequestBody({ ...PLAN, protocol: 'openai-chat-completions' }, tools,
    [{ role: 'assistant', content: '之前的答复', responseItems: [{ type: 'reasoning', id: 'rs-1' }] },
      { role: 'user', content: '[上下文已压缩] 更早的对话已移出上下文', compactionNote: true, compactionLines: ['user: 最初的目标'] }]);
  assert.equal(chat.messages[0].responseItems, undefined, '跨协议继续对话时不能把 Responses 元数据发给 Chat 接口');
  assert.equal(chat.messages[1].compactionNote, undefined, '压缩说明的本地标记不得发给 provider');
  assert.equal(chat.messages[1].compactionLines, undefined);
});
