/** URL selection is only navigation. The server revalidates room ownership and scope. */
export function savedDiscussionArtifactUrl(roomId: string, artifactId: string): string {
  return (
    '/api/discussions/' +
    encodeURIComponent(roomId) +
    '/artifacts/' +
    encodeURIComponent(artifactId)
  );
}

export function discussionArtifactUrlForDeliverable(item: {
  artifactId: string;
  kind: string;
  storageClass: string;
  path?: string;
}): string | null {
  if (item.storageClass !== 'repo' || !item.path) return null;
  const match =
    /^active\/shared\/runtime\/discussions\/([A-Za-z0-9._-]{1,96})\/(minutes\.md|brief\.html)$/u.exec(
      item.path
    );
  if (!match || match[1] === '.' || match[1] === '..') return null;
  if (item.kind !== (match[2] === 'minutes.md' ? 'markdown' : 'html')) return null;
  return savedDiscussionArtifactUrl(match[1], item.artifactId);
}
