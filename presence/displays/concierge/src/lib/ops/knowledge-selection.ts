export type KnowledgeRefreshIdentity = { tenant?: string; version: number };

export function knowledgeSelectionAfterRefresh(
  availableKeys: readonly string[],
  currentKey: string | null,
  requestedKey: string | null,
  request: KnowledgeRefreshIdentity,
  active: KnowledgeRefreshIdentity
): string | null {
  // A delayed response cannot change the current view's selection.
  if (request.tenant !== active.tenant || request.version !== active.version) return currentKey;
  // An explicit URL selector must never silently open a different candidate,
  // including when a tenant switch retains a manually selected URL key.
  if (requestedKey !== null) return requestedKey;
  return currentKey && availableKeys.includes(currentKey) ? currentKey : availableKeys[0] || null;
}
