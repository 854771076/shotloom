/**
 * 目标自动续行的持久进度只有一个落盘点：takeGoalRound。
 * 这里据实验证它只在 active 且未达上限时把 roundsStarted 加一并随之增 revision，
 * 其余情况一律收手且不写状态；再验证会话层只推进已有目标、停用时收手、绝不凭空造目标。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  takeGoalRound,
  createGoal,
  pauseGoal,
  completeGoal,
  clearGoal,
} from '../renderer/src/services/agentConversations.ts';
import { readSource } from './helpers/sourceContract.mjs';

test('takeGoalRound 只在进行中目标上推进持久轮次并递增 revision', () => {
  const project = {};
  const created = createGoal(project, '把这条短片做完', 3);
  assert.equal(created.ok, true);
  assert.equal(created.goal.roundsStarted, 0);

  const first = takeGoalRound(project);
  assert.equal(first.continued, true);
  assert.equal(first.goal.roundsStarted, 1);
  assert.equal(project.goal.roundsStarted, 1, '轮次进度必须落在持久对象上');
  assert.equal(project.goal.revision, created.goal.revision + 1, '每一续行都要 CAS revision 递增');
  assert.equal(project.goal.phase, 'active');
  assert.equal(project.goal.objective, '把这条短片做完', '推进轮次不得改动目标本身');
});

test('轮次达上限后 takeGoalRound 收手且不再改写目标', () => {
  const project = {};
  const created = createGoal(project, '做完', 2);
  takeGoalRound(project);
  takeGoalRound(project);
  assert.equal(project.goal.roundsStarted, 2);

  const exhausted = takeGoalRound(project);
  assert.equal(exhausted.continued, false);
  assert.equal(exhausted.reason, 'round-limit');

  const revision = project.goal.revision;
  takeGoalRound(project);
  assert.equal(project.goal.revision, revision, '达上限后不得再凭空增 revision');
  assert.equal(project.goal.roundsStarted, 2);
});

test('非 active 与已清除的目标不会被自动续行推进', () => {
  const paused = {};
  const created = createGoal(paused, '做完', 5);
  pauseGoal(paused, { id: created.goal.id, revision: created.goal.revision });
  const result = takeGoalRound(paused);
  assert.equal(result.continued, false);
  assert.equal(result.reason, 'inactive');
  assert.equal(paused.goal.roundsStarted, 0, '暂停的目标不该被计入续行轮次');

  const done = {};
  const finished = createGoal(done, '做完', 5);
  completeGoal(done, { id: finished.goal.id, revision: finished.goal.revision });
  const afterComplete = takeGoalRound(done);
  assert.equal(afterComplete.continued, false);
  assert.equal(afterComplete.reason, 'inactive');
  assert.equal(done.goal.roundsStarted, 0);

  const cleared = {};
  const seeded = createGoal(cleared, '做完', 5);
  clearGoal(cleared);
  const afterClear = takeGoalRound(cleared);
  assert.equal(afterClear.continued, false);
  assert.equal(afterClear.reason, 'no-goal');
  assert.equal(afterClear.goal, null);
});

test('会话层自动续行只推进已有目标并在停用时收手', () => {
  const src = readSource('renderer/src/app/adapters/agentSession.ts');
  assert.match(src, /takeGoalRound\(store\.project/, '续行轮次必须走 takeGoalRound 这唯一落盘点');
  assert.match(src, /scheduleGoalRound/, '队列清空后由同一处决策是否再开一轮');
  assert.match(src, /if \(!\(await scheduleGoalRound\(\)\)\) break;/, '只有目标仍允许续行时才继续链接下一轮');
  assert.match(src, /goalDriverArmed = true/, '一轮运行干净结束且目标仍 active 才武装续行');
  assert.ok(
    (src.match(/goalDriverArmed = false/g) || []).length >= 3,
    '停用点必须覆盖运行失败、用户停止与目标转为非 active/达上限',
  );
  assert.doesNotMatch(src, /createGoal\(/, 'driver 只推进已有目标，绝不凭空创建目标');
  assert.match(src, /update_goal/, '续行指令把 complete/blocked 交回模型，而非由应用宣布完成');
});

/**
 * 续行的竞态边界只有靠真实代码顺序才能保证：预约在派发前复核、已消耗的轮次先落盘、
 * competing 排队消息把预约顶掉。这里按源码契约断言这些承重规则都在唯一落点里。
 */
test('续行派发前先落盘并复核预约，competing 排队消息顶掉本轮', () => {
  const src = readSource('renderer/src/app/adapters/agentSession.ts');
  assert.match(src, /flushProjectCheckpoint/, 'checkpoint-before-drive 必须真的把轮次落盘');
  assert.match(src, /admitGoalRound/, '派发前必须在 drain 里先复核预约');
  assert.match(src, /if \(deliveryQueue\.length\) return false;/, 'competing-queued 时不得预约本轮');
  assert.match(src, /reservation\.stale/, '被更新的排队消息顶掉的预约必须标 stale');
  assert.match(src, /reservation\.round === goal\.roundsStarted \+ 1/, '预约轮次必须与持久 roundsStarted 对齐');
  assert.match(src, /goalRoundAttempt = null/, '派发或作废后必须清掉预约，不留半开状态');
});

test('/goal 创建或恢复后会启动首轮，暂停与停止不会在异步保存后误派发', () => {
  const adapter = readSource('renderer/src/app/adapters/agentChatAdapter.ts');
  const session = readSource('renderer/src/app/adapters/agentSession.ts');
  assert.match(adapter, /:\s*createGoal\(project, objective\);[\s\S]*?agentSession\.startGoal\(ctx\.model, conversationId\)/);
  assert.match(adapter, /command\.action === 'resume'\) agentSession\.startGoal\(ctx\.model, conversationId\)/);
  // 目标状态唯一的可见处是输入区上方的目标条：命令成功不再回显一行文本，只有失败才回错误。
  assert.doesNotMatch(adapter, /push\(`已设定长期目标|已暂停目标|已恢复目标|已清除目标/);
  assert.match(adapter, /return \{ error: result\.error \}/);
  assert.match(session, /startGoal: \(model, conversationId\) => \{[\s\S]*?goalDriverArmed = true;[\s\S]*?void drain\(\)/);
  assert.match(session, /落盘期间可能有新消息排队[\s\S]*?if \(!goalDriverArmed\) return false;/);
  assert.match(session, /goalRoundAttempt = null;\s*const latest = readGoal[\s\S]*?if \(!goalDriverArmed/);
});
