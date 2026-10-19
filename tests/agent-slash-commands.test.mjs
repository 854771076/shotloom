import test from 'node:test';
import assert from 'node:assert/strict';

import {
  matchSlashCommands,
  parseSlashCommand,
  SLASH_COMMANDS,
} from '../renderer/src/app/agent-chat/slashCommands.ts';

// 命令层是封闭集合：解析器只认 goal/plan，其余 `/xxx` 一律交回技能流程，命令层不越权解释。
test('只识别保留命令，其余斜杠词一律不当作命令', () => {
  assert.equal(parseSlashCommand('/short-drama 写三集'), null);
  assert.equal(parseSlashCommand('普通消息'), null);
  assert.equal(parseSlashCommand(''), null);
  assert.equal(parseSlashCommand('/'), null);
  assert.deepEqual(SLASH_COMMANDS.map((item) => item.id), ['goal', 'plan']);
});

test('/goal 的每个动作都被解析成对应的命令意图', () => {
  assert.deepEqual(parseSlashCommand('/goal'), { kind: 'goal', action: 'status' });
  assert.deepEqual(parseSlashCommand('/goal status'), { kind: 'goal', action: 'status' });
  assert.deepEqual(parseSlashCommand('/goal pause'), { kind: 'goal', action: 'pause' });
  assert.deepEqual(parseSlashCommand('/goal resume'), { kind: 'goal', action: 'resume' });
  assert.deepEqual(parseSlashCommand('/goal complete'), { kind: 'goal', action: 'complete' });
  assert.deepEqual(parseSlashCommand('/goal clear'), { kind: 'goal', action: 'clear' });
  // 子动作词大小写不敏感。
  assert.deepEqual(parseSlashCommand('/goal PAUSE'), { kind: 'goal', action: 'pause' });
});

test('/goal 带任意正文视为设定目标，正文原样保留为 objective', () => {
  assert.deepEqual(
    parseSlashCommand('/goal  把这部长剧做到可交付 '),
    { kind: 'goal', action: 'set', objective: '把这部长剧做到可交付' },
  );
  // 多行目标描述不能被空白切分规则截断。
  assert.deepEqual(
    parseSlashCommand('/goal 第一行\n第二行'),
    { kind: 'goal', action: 'set', objective: '第一行\n第二行' },
  );
});

test('/plan 的开关、查询与带正文进入分别解析', () => {
  assert.deepEqual(parseSlashCommand('/plan'), { kind: 'plan', action: 'enter' });
  assert.deepEqual(parseSlashCommand('/plan exit'), { kind: 'plan', action: 'exit' });
  assert.deepEqual(parseSlashCommand('/plan off'), { kind: 'plan', action: 'exit' });
  assert.deepEqual(parseSlashCommand('/plan status'), { kind: 'plan', action: 'status' });
  // 唯一携带 deliverText 的分支：正文要作为本轮真实请求发出。
  assert.deepEqual(
    parseSlashCommand('/plan 先只读调研这个剧本'),
    { kind: 'plan', action: 'enter', deliverText: '先只读调研这个剧本' },
  );
});

test('/ 候选面板先给命令再给技能，且命令按查询过滤', () => {
  assert.deepEqual(matchSlashCommands('').map((item) => item.id), ['goal', 'plan']);
  assert.deepEqual(matchSlashCommands('pl').map((item) => item.id), ['plan']);
  assert.deepEqual(matchSlashCommands('目标').map((item) => item.id), ['goal']);
  assert.deepEqual(matchSlashCommands('zzz'), []);
});
