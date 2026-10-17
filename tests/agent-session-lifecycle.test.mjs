import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compactInactiveAgentSessions,
  agentSessionLifecycleDiagnostics,
  expandAgentArchivesForPersistence,
  restoreAgentSession,
} from '../renderer/src/services/agentSessionLifecycle.ts';

test('inactive agent sessions compact in memory and persist with complete history', () => {
  const messages = Array.from({ length: 170 }, (_, index) => ({
    id: `m-${index}`,
    content: String(index),
  }));
  const project = {
    id: `project-session-lifecycle-${Date.now()}`,
    activeAgentConversationId: 'active',
    agentConversations: [
      { id: 'active', messages: [] },
      { id: 'inactive', messages },
    ],
  };
  assert.deepEqual(compactInactiveAgentSessions(project), {
    compacted: 1,
    removedObjects: 90,
  });
  assert.equal(project.agentConversations[1].messages.length, 80);
  assert.equal(agentSessionLifecycleDiagnostics().archivedMessages >= 90, true);

  const persisted = expandAgentArchivesForPersistence(structuredClone(project));
  assert.equal(persisted.agentConversations[1].messages.length, 170);
  assert.equal(restoreAgentSession(project, 'inactive'), 90);
  assert.equal(project.agentConversations[1].messages.length, 170);
});
