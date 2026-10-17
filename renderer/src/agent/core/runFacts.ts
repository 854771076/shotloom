import type { AgentRunFacts, AgentToolReceipt } from './types';

/**
 * 一轮运行的共享事实容器。
 *
 * 字段必须是"创建即存在"的：管道里的记账是直接写字段，而不是先读 Map 再补建容器，
 * 否则并发派发时后启动的调用会把先写入的记录整个覆盖。
 */
export function createAgentRunFacts(init: Partial<AgentRunFacts> = {}): AgentRunFacts {
  return {
    hasAppliedActions: false,
    expectedCanvasFingerprint: '',
    activeProductionPlanId: '',
    toolReceipts: new Map<string, AgentToolReceipt>(),
    successfulToolCallIds: new Set<string>(),
    ...init,
  };
}
