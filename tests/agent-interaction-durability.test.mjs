import assert from 'node:assert/strict';

import test from 'node:test';
import { readSource } from './helpers/sourceContract.mjs';

const runStore = readSource('renderer/src/agent/runtime/runStore.ts');
const projectStore = readSource('renderer/src/store/projectStore.ts')
  + readSource('renderer/src/store/projectNormalization.ts');
const closeGuard = readSource('renderer/src/app/windowCloseGuard.ts');
const lifecycle = readSource('renderer/src/agent/tools/lifecycleTools.ts');

test('Agent 问题和工具确认使用统一的项目级持久化交互', () => {
  assert.match(projectStore, /agentInteractions: \[\]/);
  assert.match(projectStore, /agentInteractions: Array\.isArray\(project\?\.agentInteractions\)/);
  assert.match(runStore, /kind: AgentInteractionKind/);
  assert.match(runStore, /status: AgentInteractionStatus/);
  assert.match(runStore, /continuation: AgentRunContinuation/);
  assert.match(runStore, /expiresAt: string/);
});

test('结构化澄清支持批量问题且关闭窗口受 Runtime 健康状态保护', () => {
  assert.match(lifecycle, /type: 'array', minItems: 1/);
  assert.doesNotMatch(lifecycle, /clarificationCount|maxItems: 3(?:\s*[,}])|questions\.length > 3/);
  assert.match(lifecycle, /multiple: \{ type: 'boolean' \}/);
  assert.match(closeGuard, /getAgentRuntimeHealth/);
  assert.match(closeGuard, /blockingReasons/);
});
