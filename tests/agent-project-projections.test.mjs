/**
 * 项目级事件溯源投影引擎的行为契约：纯折叠、整值事件、引用稳定、变更抑制、checkpoint 压缩与
 * 尾重放、stateVersion 作废、以及会话态回合边界投影。这些都是"可重放性/竞态消除"的地基，
 * 属于必须成立的持久化与安全边界。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TURN_BOUNDARY_KEY,
  checkpointProjectProjections,
  commitProjectionEvent,
  createSessionProjectionHost,
  projectProjectionHost,
  projectionView,
  registerProjection,
  registeredProjectionKeys,
  restoreProjectProjections,
  stateOfProjection,
} from '../renderer/src/store/projectProjections.ts';
import { getDomainRevision, reactive } from '../renderer/src/store/domainReactivity.ts';

const counterDefinition = {
  key: 'test/counter',
  stateVersion: 2,
  init: () => ({ count: 0 }),
  apply: (state, event) => {
    if (event.type !== 'test/set') return state;
    const next = Number(event.data.value);
    return next === state.count ? state : { count: next };
  },
  validate: (value) => (
    value && typeof value === 'object' && Number.isFinite(value.count)
      ? { count: Number(value.count) }
      : null
  ),
  view: (state) => state.count,
};

// 注册即副作用：本文件只注册这一个自定义单元，验证引擎本身；goal/planMode 的注册属于会话服务层。
registerProjection(counterDefinition, (target, view) => {
  target.testCount = view;
});

test('apply 是纯折叠：无关事件与同值事件都必须返回同一引用', () => {
  const state = counterDefinition.init();
  assert.equal(counterDefinition.apply(state, { seq: 0, type: 'goal/change', data: {} }), state);
  assert.equal(counterDefinition.apply(state, { seq: 1, type: 'test/set', data: { value: 0 } }), state);
  const next = counterDefinition.apply(state, { seq: 2, type: 'test/set', data: { value: 3 } });
  assert.notEqual(next, state);
  assert.equal(next.count, 3);
});

test('整值事件折叠后即为携带的完整快照，并物化到宿主字段', () => {
  const project = {};
  const host = projectProjectionHost(project);
  commitProjectionEvent(host, 'test/set', { value: 3 });
  commitProjectionEvent(host, 'test/set', { value: 4 });
  assert.equal(project.testCount, 4);
  assert.equal(projectionView(host, 'test/counter'), 4);
  assert.equal(project.projectionSeq, 2, 'seq 在 host 内单调递增');
  assert.deepEqual(project.projectionJournal.map((event) => event.data.value), [3, 4]);
  assert.ok(registeredProjectionKeys().includes('test/counter'));
});

test('与当前 view 等价的事件被 apply 抑制，不触发物化与领域通知', async () => {
  const project = reactive({});
  const host = projectProjectionHost(project);
  commitProjectionEvent(host, 'test/set', { value: 5 });
  await Promise.resolve();
  const before = getDomainRevision();
  commitProjectionEvent(host, 'test/set', { value: 5 });
  await Promise.resolve();
  assert.equal(getDomainRevision(), before, '等价事件不得再写一次物化字段');
  commitProjectionEvent(host, 'test/set', { value: 6 });
  await Promise.resolve();
  assert.equal(getDomainRevision(), before + 1, '真实变化仍要物化并触发一次领域通知');
});

test('checkpoint 压实尾日志，checkpoint + 尾重放与全量重放结果一致', () => {
  const project = {};
  const host = projectProjectionHost(project);
  for (let value = 1; value <= 4; value += 1) commitProjectionEvent(host, 'test/set', { value });
  assert.equal(project.projectionJournal.length, 4);

  checkpointProjectProjections(project);
  assert.equal(project.projectionJournal.length, 0, '压实后尾日志清空，存储有界');
  assert.equal(project.projectionCheckpoint['test/counter'].seq, 3, 'checkpoint 记住当前游标');
  assert.equal(project.projectionCheckpoint['test/counter'].state.count, 4);

  commitProjectionEvent(host, 'test/set', { value: 9 });

  // 模拟一次重载：只带 checkpoint 行 + 尾日志，没有内存 cell。
  const reloaded = {
    projectionJournal: JSON.parse(JSON.stringify(project.projectionJournal)),
    projectionCheckpoint: JSON.parse(JSON.stringify(project.projectionCheckpoint)),
    projectionSeq: project.projectionSeq,
  };
  const reloadHost = projectProjectionHost(reloaded);
  assert.equal(projectionView(reloadHost, 'test/counter'), 9, 'checkpoint + 尾日志重放得到同一结果');

  const fromScratch = {
    projectionJournal: [1, 2, 3, 4, 9].map((value, seq) => ({ seq, type: 'test/set', data: { value } })),
    projectionSeq: 5,
  };
  assert.equal(
    projectionView(projectProjectionHost(fromScratch), 'test/counter'),
    9,
    '全量重放与 checkpoint 路径一致',
  );
});

test('stateVersion 失配的 checkpoint 行被丢弃并全量重放尾日志', () => {
  const stale = {
    projectionCheckpoint: {
      'test/counter': { ver: counterDefinition.stateVersion + 1, seq: 99, state: { count: 100 } },
    },
    projectionJournal: [{ seq: 0, type: 'test/set', data: { value: 7 } }],
    projectionSeq: 1,
  };
  const host = projectProjectionHost(stale);
  assert.equal(projectionView(host, 'test/counter'), 7, '旧版本 checkpoint 被丢弃，从 init 重放');
});

test('restore 只在存在日志/checkpoint 证据时以日志为准物化字段', () => {
  const withEvidence = {
    testCount: 999,
    projectionJournal: [{ seq: 0, type: 'test/set', data: { value: 12 } }],
    projectionSeq: 1,
  };
  restoreProjectProjections(withEvidence);
  assert.equal(withEvidence.testCount, 12, '日志优先于陈旧的物化字段');

  const legacy = { testCount: 42, goal: { objective: '历史目标' } };
  restoreProjectProjections(legacy);
  assert.equal(legacy.testCount, 42, '没有日志证据的 legacy 项目保持字段原样');
});

test('会话作用域的回合边界投影不进项目 checkpoint', () => {
  const project = {};
  const host = projectProjectionHost(project);
  commitProjectionEvent(host, 'test/set', { value: 1 });
  checkpointProjectProjections(project);
  assert.ok('test/counter' in project.projectionCheckpoint);
  assert.equal('turnBoundary' in project.projectionCheckpoint, false, '运行态投影不得写进项目快照');
});

test('turn 边界投影：开启后 open=true，闭合后 open=false，重复闭合幂等', () => {
  const host = createSessionProjectionHost();
  assert.deepEqual(projectionView(host, TURN_BOUNDARY_KEY), { open: false, turn: 0 });
  commitProjectionEvent(host, 'turn/start', { turn: 1 });
  assert.deepEqual(projectionView(host, TURN_BOUNDARY_KEY), { open: true, turn: 1 });
  commitProjectionEvent(host, 'turn/end', {});
  assert.deepEqual(projectionView(host, TURN_BOUNDARY_KEY), { open: false, turn: 1 });
  const closed = stateOfProjection(host, TURN_BOUNDARY_KEY);
  commitProjectionEvent(host, 'turn/end', {});
  assert.equal(stateOfProjection(host, TURN_BOUNDARY_KEY), closed, '已闭合回合再次闭合返回同一引用');
});
