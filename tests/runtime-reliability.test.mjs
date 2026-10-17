import assert from 'node:assert/strict';

import test from 'node:test';
import { readSource } from './helpers/sourceContract.mjs';

const read = (path) => readSource(path);

test('workspace writes use instance, generation and canvas revision fences', () => {
  const identity = read('renderer/src/services/agentProjectIdentity.ts');
  const tools = read('renderer/src/agent/tools/canvasTools.ts');
  const executor = read('renderer/src/services/agent/agentCanvasExecutor.ts');
  assert.match(identity, /instanceId: string/);
  assert.match(identity, /generation: number/);
  assert.match(tools, /expectedCanvasFingerprint/);
  assert.match(tools, /AgentCanvasRevisionConflictError/);
  assert.match(executor, /body\.projectInstanceId/);
  assert.match(executor, /body\.projectGeneration/);
});

test('crash recovery persists heartbeats and relieves sustained memory pressure', () => {
  const recovery = read('src-tauri/src/commands/recovery.rs');
  const workbench = read('renderer/src/app/ReactWorkbench.tsx');
  assert.match(recovery, /runtime-recovery\.json/);
  assert.match(recovery, /previous-unclean-exit\.json/);
  assert.match(recovery, /system-memory-pressure/);
  assert.match(recovery, /low_memory_polls/);
  assert.match(workbench, /recoverInterruptedAgentRuns/);
  assert.match(workbench, /relieveAgentHistoryMemoryPressure/);
});

test('durable JSON storage isolates corruption and rejects legacy schemas', () => {
  const common = read('src-tauri/src/commands/common.rs');
  const settings = read('src-tauri/src/commands/settings.rs');
  const projects = read('renderer/src/store/projectStore.ts')
    + read('renderer/src/store/projectNormalization.ts');
  assert.match(common, /\.corrupt-\{stamp\}/);
  assert.match(common, /tmp-\{\}/);
  assert.match(settings, /SETTINGS_STORAGE_VERSION: u64 = 7/);
  assert.match(settings, /fn validate_current_settings/);
  assert.doesNotMatch(settings, /fn migrate_settings/);
  assert.match(projects, /PROJECT_SCHEMA_VERSION = 2/);
  assert.match(projects, /function assertCurrentProjectSchema/);
  assert.doesNotMatch(projects, /function migrateProject\s*\(/);
});

test('agent hot paths use coalesced streaming, single user delivery and latest-wins persistence', () => {
  const presenter = read('renderer/src/app/agent-session/runtimePresenter.ts');
  const session = read('renderer/src/app/adapters/agentSession.ts');
  const adapter = read('renderer/src/app/adapters/agentChatAdapter.ts');
  const saveQueue = read('renderer/src/services/latestSaveQueue.ts');
  assert.match(presenter, /cachedStructuralSnapshot/);
  assert.match(session, /window\.setTimeout\(flush, 32\)/);
  assert.match(session, /MAX_QUEUED_DELIVERIES = 3/);
  assert.match(session, /if \(deliveryProcessing\) return/);
  assert.match(session, /steerLoopAgent\(activeRequestId, steeringText\)/);
  assert.match(session, /runningConversationId === String\(conversation\.id \|\| ""\)/);
  assert.doesNotMatch(session, /deliveryStage: "queued"/);
  // 运行状态只在会话单元里；适配层是投影与装配，不得再自己留一份"现在忙不忙"。
  assert.doesNotMatch(adapter, /let busy|let activeRequestId|deliveryQueue|MAX_QUEUED_DELIVERIES/);
  assert.match(adapter, /busy: agentSession\.isBusy\(\)/);
  assert.match(saveQueue, /pendingLatest/);
  assert.match(saveQueue, /maxRetryAttempts/);
  assert.match(saveQueue, /waitForIdle\(\)/);
});

test('agent canvas writes land in one typed action module', () => {
  const executor = read('renderer/src/services/agent/agentCanvasExecutor.ts');
  const handlers = read('renderer/src/services/agent/agentActionHandlers.ts');
  // 工具层 → 执行器（批次）→ 动作实现（单一落点）→ 存储；不得再插入注册表转接层。
  assert.doesNotMatch(executor, /actionRegistry|registerDefaultActions|dispatchAction\(/);
  assert.match(handlers, /export async function applyAgentAction/);
  assert.match(handlers, /switch \(action\?\.type\)/);
  // 上下文只暴露项目本体与引用解析，动作实现不能再拿到可随意塞状态的宽松记录。
  assert.match(handlers, /export interface ActionHandlerContext \{[^}]*resolveNodeId/s);
  assert.doesNotMatch(handlers, /interface ActionHandlerContext \{[^}]*\[key: string]/s);
  // create_gen_node 的 inputLinks 与 connect_nodes 必须共用同一套输入边写入，
  // 否则两个工具入口会持久化出两种边结构。
  assert.match(handlers, /connectInputEdge\(node\.id/);
  assert.match(handlers, /connectInputEdge\(targetId/);
});

test('plan writes fence stale revisions and session archives stay bounded', () => {
  const plans = read('renderer/src/agent/runtime/productionPlanStore.ts');
  const tools = read('renderer/src/agent/tools/productionPlanTools.ts');
  const sessions = read('renderer/src/services/agentSessionLifecycle.ts');
  assert.match(plans, /StaleProductionPlanRevisionError/);
  assert.match(tools, /expectedRevision/);
  assert.match(sessions, /DEFAULT_KEEP_COUNT = 80/);
  assert.match(sessions, /expandAgentArchivesForPersistence/);
});
