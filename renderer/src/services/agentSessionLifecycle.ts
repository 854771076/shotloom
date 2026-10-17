import type { ConversationMessage, ConversationProject } from './agentConversations.ts';

const archives = new Map<string, string>();
const DEFAULT_KEEP_COUNT = 80;
const DEFAULT_MIN_COUNT = 160;
const MAX_ARCHIVED_SESSIONS = 100;

const keyFor = (projectId: string | number, conversationId: string | number | undefined) =>
  `${projectId}:${conversationId}`;

function parseArchive(key: string): ConversationMessage[] {
  const serialized = archives.get(key);
  if (!serialized) return [];
  try {
    const value = JSON.parse(serialized);
    return Array.isArray(value) ? (value as ConversationMessage[]) : [];
  } catch {
    archives.delete(key);
    return [];
  }
}

function mergeMessages(archived: ConversationMessage[], current: ConversationMessage[]): ConversationMessage[] {
  const merged: ConversationMessage[] = [];
  const seen = new Set<string>();
  for (const message of [...archived, ...current]) {
    const id = String(message?.id || '');
    const identity = id || JSON.stringify([message?.createdAt, message?.role, message?.content]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    merged.push(message);
  }
  return merged;
}

export function compactInactiveAgentSessions(
  project: ConversationProject | null | undefined,
  { keepCount = DEFAULT_KEEP_COUNT, minCount = DEFAULT_MIN_COUNT }: { keepCount?: number; minCount?: number } = {},
): { compacted: number; removedObjects: number } {
  if (!project?.id || !Array.isArray(project.agentConversations)) {
    return { compacted: 0, removedObjects: 0 };
  }
  let compacted = 0;
  let removedObjects = 0;
  for (const conversation of project.agentConversations) {
    if (conversation.id === project.activeAgentConversationId) continue;
    if (!Array.isArray(conversation.messages) || conversation.messages.length < minCount) continue;
    const splitAt = Math.max(0, conversation.messages.length - keepCount);
    const oldMessages = conversation.messages.slice(0, splitAt);
    const recentMessages = conversation.messages.slice(splitAt);
    const key = keyFor(project.id, conversation.id);
    const archived = mergeMessages(parseArchive(key), oldMessages);
    archives.set(key, JSON.stringify(archived));
    while (archives.size > MAX_ARCHIVED_SESSIONS) {
      // 迭代器此刻必然还有下一个 key（size 大于上限），但类型上仍要显式排除 undefined。
      const oldest = archives.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      archives.delete(oldest);
    }
    conversation.messages = recentMessages;
    conversation.archivedMessageCount = archived.length;
    compacted += 1;
    removedObjects += oldMessages.length;
  }
  return { compacted, removedObjects };
}

export function restoreAgentSession(project: ConversationProject | null | undefined, conversationId: string): number {
  if (!project?.id || !Array.isArray(project.agentConversations)) return 0;
  const conversation = project.agentConversations.find((item) => item.id === conversationId);
  if (!conversation) return 0;
  const key = keyFor(project.id, conversationId);
  const archived = parseArchive(key);
  if (!archived.length) return 0;
  conversation.messages = mergeMessages(
    archived,
    Array.isArray(conversation.messages) ? conversation.messages : [],
  );
  delete conversation.archivedMessageCount;
  archives.delete(key);
  return archived.length;
}

export function expandAgentArchivesForPersistence<T extends ConversationProject | null | undefined>(
  projectSnapshot: T,
): T {
  if (!projectSnapshot?.id || !Array.isArray(projectSnapshot.agentConversations)) {
    return projectSnapshot;
  }
  for (const conversation of projectSnapshot.agentConversations) {
    const archived = parseArchive(keyFor(projectSnapshot.id, conversation.id));
    if (!archived.length) continue;
    conversation.messages = mergeMessages(
      archived,
      Array.isArray(conversation.messages) ? conversation.messages : [],
    );
    delete conversation.archivedMessageCount;
  }
  return projectSnapshot;
}

export function agentSessionLifecycleDiagnostics(): { archivedSessions: number; archivedMessages: number } {
  let archivedMessages = 0;
  for (const key of archives.keys()) archivedMessages += parseArchive(key).length;
  return { archivedSessions: archives.size, archivedMessages };
}

export function dropAgentSessionArchive(
  projectId: string | number,
  conversationId: string | number | undefined,
): boolean {
  return archives.delete(keyFor(projectId, conversationId));
}
