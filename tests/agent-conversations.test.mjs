import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAgentConversation,
  clearAgentConversation,
  deleteAgentConversation,
  ensureAgentConversations,
  getActiveAgentConversation,
  switchAgentConversation,
  canvasAgentConversation,
  editorAgentConversation,
  textAgentConversation,
  scopedAgentConversations,
  readGoal,
  createGoal,
  editGoal,
  pauseGoal,
  resumeGoal,
  completeGoal,
  blockGoal,
  clearGoal,
  isPlanMode,
  setPlanMode,
  normalizeProjectState,
} from '../renderer/src/services/agentConversations.ts';

test('清空会话同时丢弃模型可见历史', () => {
  const project = {};
  const active = getActiveAgentConversation(project);
  active.messages.push({ id: 'old-message' });
  active.runtimeTranscript = [{ role: 'user', content: '上一轮' }];

  clearAgentConversation(project, active.id);

  assert.deepEqual(active.messages, []);
  assert.equal(active.runtimeTranscript, undefined, '界面清空后模型也必须不再记得上一轮');
});

test('empty project gets one canonical conversation', () => {
  const project = {};
  ensureAgentConversations(project);
  const active = getActiveAgentConversation(project);
  assert.deepEqual(active.messages, []);
  assert.equal(active.agentMessages, undefined);
  assert.equal(project.activeAgentConversationId, active.id);
});

test('reading an already normalized conversation is idempotent', () => {
  const project = {};
  ensureAgentConversations(project);
  const conversations = project.agentConversations;
  const active = getActiveAgentConversation(project);
  assert.equal(project.agentConversations, conversations);
  assert.equal(getActiveAgentConversation(project), active);
  assert.equal(project.agentConversations, conversations);
});

test('reading active conversation preserves the in-memory streaming reply', () => {
  const project = {};
  const active = getActiveAgentConversation(project);
  const streaming = { id: 'streaming', role: 'assistant', content: '正在', transient: true };
  active.messages.push(streaming);

  const reread = getActiveAgentConversation(project);

  assert.equal(reread.messages.length, 1);
  assert.equal(reread.messages[0], streaming);
  assert.equal(reread.messages[0].content, '正在');
});

test('switching conversations changes the canonical active conversation', () => {
  const project = {};
  const first = getActiveAgentConversation(project);
  first.messages.push({ id: 'first' });
  const second = createAgentConversation(project, { title: 'second' });
  second.messages.push({ id: 'second' });
  switchAgentConversation(project, first.id);
  assert.deepEqual(getActiveAgentConversation(project).messages, [{ id: 'first' }]);
  assert.notEqual(getActiveAgentConversation(project).messages, second.messages);
});

test('deleting the active conversation selects a remaining conversation and clears its pending steps', () => {
  const project = {};
  const first = getActiveAgentConversation(project);
  const second = createAgentConversation(project, { title: 'second' });
  project.agentSteps = [
    { id: 'keep', conversationId: first.id },
    { id: 'remove', conversationId: second.id },
  ];

  deleteAgentConversation(project, second.id);

  assert.equal(project.activeAgentConversationId, first.id);
  assert.deepEqual(project.agentConversations, [first]);
  assert.deepEqual(project.agentSteps, [{ id: 'keep', conversationId: first.id }]);
});

test('deleting the last conversation creates a fresh canonical conversation', () => {
  const project = {};
  const only = getActiveAgentConversation(project);

  const replacement = deleteAgentConversation(project, only.id);

  assert.equal(project.agentConversations.length, 1);
  assert.equal(project.activeAgentConversationId, replacement.id);
  assert.notEqual(replacement.id, only.id);
  assert.deepEqual(replacement.messages, []);
});

test('canvas scope hides editor conversations and lists newest first', () => {
  const project = {};
  const oldest = getActiveAgentConversation(project);
  oldest.updatedAt = '2026-01-01T00:00:00.000Z';
  const newest = createAgentConversation(project);
  newest.updatedAt = '2026-01-02T00:00:00.000Z';
  const editor = createAgentConversation(project, { title: '剪辑 Agent' });
  editor.editorNodeId = 'node-editor';

  assert.deepEqual(
    scopedAgentConversations(project, 'canvas').map((item) => item.id),
    [newest.id, oldest.id],
  );
  assert.deepEqual(
    scopedAgentConversations(project, 'editor', 'node-editor').map((item) => item.id),
    [editor.id],
  );
  assert.deepEqual(scopedAgentConversations(project, 'editor', 'node-other'), []);
  assert.deepEqual(scopedAgentConversations(project, 'editor', ''), []);
});

test('canvas panel resolves its own conversation while the project pointer sits on an editor conversation', () => {
  const project = {};
  const canvas = getActiveAgentConversation(project);
  const editor = createAgentConversation(project, { title: '剪辑 Agent' });
  editor.editorNodeId = 'node-editor';
  assert.equal(project.activeAgentConversationId, editor.id);

  const resolved = canvasAgentConversation(project);

  assert.equal(resolved.id, canvas.id);
  assert.notEqual(resolved.id, editor.id);
});

test('canvas scope creates a canonical conversation when only editor conversations remain', () => {
  const project = {};
  const canvas = getActiveAgentConversation(project);
  const editor = createAgentConversation(project, { title: '剪辑 Agent' });
  editor.editorNodeId = 'node-editor';
  project.agentConversations = project.agentConversations.filter(
    (item) => item.id !== canvas.id,
  );

  const resolved = canvasAgentConversation(project);

  assert.equal(resolved.editorNodeId, undefined);
  assert.equal(project.activeAgentConversationId, resolved.id);
  assert.equal(scopedAgentConversations(project, 'canvas').length, 1);
});

test('editor scope creates one conversation per editor node and reuses it', () => {
  const project = {};
  getActiveAgentConversation(project);

  const created = editorAgentConversation(project, 'node-a');

  assert.equal(created.editorNodeId, 'node-a');
  assert.equal(created.title, '剪辑 Agent');
  assert.equal(editorAgentConversation(project, 'node-a'), created);
  assert.notEqual(editorAgentConversation(project, 'node-b').id, created.id);
});

test('会话记录显式携带所属 Agent，运行时的权限集合据此解析', () => {
  const project = {};
  const canvas = getActiveAgentConversation(project);
  const editor = editorAgentConversation(project, 'node-a');

  assert.equal(canvas.agentId, 'canvas-primary');
  assert.equal(editor.agentId, 'editor-primary');
  assert.equal(createAgentConversation(project, { title: '新对话' }).agentId, 'canvas-primary');
});

test('历史会话缺少 agentId 时按作用域补齐', () => {
  const project = {
    agentConversations: [
      { id: 'legacy-canvas', title: '旧对话', messages: [], updatedAt: '2026-01-01' },
      { id: 'legacy-editor', title: '剪辑 Agent', messages: [], editorNodeId: 'node-1', updatedAt: '2026-01-02' },
    ],
  };

  ensureAgentConversations(project);

  assert.equal(project.agentConversations[0].agentId, 'canvas-primary');
  assert.equal(project.agentConversations[1].agentId, 'editor-primary');
});

test('clearing targets one conversation without touching the other scope', () => {
  const project = {};
  const canvas = getActiveAgentConversation(project);
  const editor = editorAgentConversation(project, 'node-editor');
  canvas.messages.push({ id: 'canvas-message' });
  editor.messages.push({ id: 'editor-message' });
  editor.runtimeTranscript = [{ role: 'user', content: '编辑器会话历史' }];
  assert.equal(project.activeAgentConversationId, editor.id);

  clearAgentConversation(project, canvas.id);

  assert.deepEqual(canvas.messages, []);
  assert.deepEqual(editor.messages, [{ id: 'editor-message' }]);
  assert.deepEqual(editor.runtimeTranscript, [{ role: 'user', content: '编辑器会话历史' }]);
});

test('文本作用域每个节点一个会话，且不会出现在画布和剪辑列表里', () => {
  const project = {};
  getActiveAgentConversation(project);

  const created = textAgentConversation(project, 'text-a');

  assert.equal(created.textNodeId, 'text-a');
  assert.equal(created.title, '文本 Agent');
  assert.equal(textAgentConversation(project, 'text-a'), created);
  assert.notEqual(textAgentConversation(project, 'text-b').id, created.id);

  assert.deepEqual(
    scopedAgentConversations(project, 'text', 'text-a').map((item) => item.id),
    [created.id],
  );
  assert.deepEqual(scopedAgentConversations(project, 'text', ''), []);
  assert.equal(scopedAgentConversations(project, 'editor', 'text-a').length, 0);
  assert.equal(
    scopedAgentConversations(project, 'canvas').some((item) => item.textNodeId),
    false,
    '文本会话不得混进画布历史',
  );
});

test('文本面板的会话解析不受项目级活动指针影响', () => {
  const project = {};
  const canvas = getActiveAgentConversation(project);
  const text = textAgentConversation(project, 'text-a');
  const editor = editorAgentConversation(project, 'node-editor');
  assert.equal(project.activeAgentConversationId, editor.id);

  assert.equal(textAgentConversation(project, 'text-a').id, text.id);
  assert.equal(canvasAgentConversation(project).id, canvas.id);
});

test('文本会话记录携带 text-primary，历史缺字段时按节点补齐', () => {
  assert.equal(textAgentConversation({}, 'text-a').agentId, 'text-primary');

  const project = {
    agentConversations: [
      { id: 'legacy-text', title: '文本 Agent', messages: [], textNodeId: 'text-1', updatedAt: '2026-01-03' },
    ],
  };

  ensureAgentConversations(project);

  assert.equal(project.agentConversations[0].agentId, 'text-primary');
});

test('goal 只在项目级规范化路径保持引用稳定', () => {
  const project = { agentConversations: [] };
  const created = createGoal(project, '做一支 30 秒产品广告');
  assert.equal(created.ok, true);
  const reference = project.goal;

  // ensure 是渲染/会话路径，绝不该改写项目级 goal 引用；normalizeProjectState 幂等也不新建对象。
  // 任一路径每次新建对象都会持续 bump domain revision，渲染期读它就是无限重渲染。
  ensureAgentConversations(project);
  normalizeProjectState(project);
  normalizeProjectState(project);
  assert.equal(project.goal, reference, 'goal 引用在 ensure 与 normalize 下必须稳定');
});

test('legacy 非法 goal 被就地规范化，空白 objective 被丢弃', () => {
  const project = { goal: { objective: '  做一支  30 秒广告  ', phase: 'weird' } };
  normalizeProjectState(project);

  assert.equal(project.goal.objective, '做一支 30 秒广告');
  assert.equal(project.goal.phase, 'active');
  assert.equal(project.goal.revision, 1);

  const blank = { goal: { objective: '   ' } };
  normalizeProjectState(blank);
  assert.equal(blank.goal, null, '空白 objective 的目标被丢弃');
});

test('goal 生命周期动词按 CAS 推进并拒绝陈旧 revision', () => {
  const project = {};
  const created = createGoal(project, '目标一');
  assert.equal(created.ok, true);
  const goal = created.goal;
  assert.equal(goal.revision, 1);

  // 已有进行中的目标不能被替换。
  assert.equal(createGoal(project, '目标二').ok, false);

  const edited = editGoal(project, { id: goal.id, revision: goal.revision }, { objective: '目标一改好了' });
  assert.equal(edited.ok, true);
  assert.equal(project.goal.revision, 2);

  // 携带已被上一次变更推走的 revision → 清晰拒绝，不覆盖。
  const stale = editGoal(project, { id: goal.id, revision: 1 }, { objective: '陈旧写入' });
  assert.equal(stale.ok, false);
  assert.match(stale.error, /已被更新/);

  const paused = pauseGoal(project, { id: goal.id, revision: 2 });
  assert.equal(paused.ok, true);
  assert.equal(project.goal.phase, 'paused');
  // 暂停的目标不能再次暂停。
  assert.equal(pauseGoal(project, { id: goal.id, revision: 3 }).ok, false);

  const resumed = resumeGoal(project, { id: goal.id, revision: 3 });
  assert.equal(resumed.ok, true);
  assert.equal(project.goal.phase, 'active');

  const blocked = blockGoal(project, { id: goal.id, revision: 4 }, '接口配额耗尽');
  assert.equal(blocked.ok, true);
  assert.equal(project.goal.phase, 'blocked');
  assert.equal(project.goal.blockedReason, '接口配额耗尽');

  const completed = completeGoal(project, { id: goal.id, revision: 5 });
  assert.equal(completed.ok, true);
  assert.equal(project.goal.phase, 'complete');
  assert.equal(project.goal.blockedReason, undefined);

  clearGoal(project);
  assert.equal(project.goal, null);
});

test('已完成的目标可被新目标替换；轮次耗尽时不能恢复', () => {
  const project = {};
  const first = createGoal(project, '旧目标').goal;
  completeGoal(project, { id: first.id, revision: first.revision });
  assert.equal(createGoal(project, '新目标').ok, true, 'complete 之后可直接被替代');

  const goal = project.goal;
  goal.roundsStarted = goal.maxGoalRounds;
  pauseGoal(project, { id: goal.id, revision: goal.revision });
  const resume = resumeGoal(project, { id: goal.id, revision: goal.revision + 1 });
  assert.equal(resume.ok, false);
  assert.match(resume.error, /上限/);
});

test('planMode 是项目级严格布尔开关，normalizeProjectState 幂等', () => {
  const project = {};
  assert.equal(isPlanMode(project), false);
  setPlanMode(project, true);
  assert.equal(isPlanMode(project), true);
  setPlanMode(project, false);
  assert.equal(isPlanMode(project), false);

  // 严格布尔：只有 === true 算开启，其它非法值规范化为 false。
  const legacy = { planMode: 1 };
  normalizeProjectState(legacy);
  assert.equal(legacy.planMode, false);

  // 幂等：规范化不改动已合法 goal 的引用。
  const goalProject = {};
  createGoal(goalProject, '目标');
  const reference = goalProject.goal;
  normalizeProjectState(goalProject);
  assert.equal(goalProject.goal, reference);
});

test('goal 与 planMode 是项目级：清空会话只清消息，不动项目状态', () => {
  const project = { agentConversations: [] };
  const conversation = getActiveAgentConversation(project);
  createGoal(project, '长期目标');
  setPlanMode(project, true);
  conversation.messages.push({ id: 'm1' });

  clearAgentConversation(project, conversation.id);

  // 清空单个会话只清其消息；项目级 goal/plan 独立于任一会话，不能被连带清掉。
  assert.equal(conversation.messages.length, 0);
  assert.equal(readGoal(project)?.objective, '长期目标');
  assert.equal(isPlanMode(project), true);
});
