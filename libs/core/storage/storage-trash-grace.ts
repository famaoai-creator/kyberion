/**
 * Grace start for one trashed file, from the trash index.
 *
 * A soft-delete of a directory records ONE index entry for the directory,
 * while the sweep walks the files inside it. Looking up the file path alone
 * therefore missed every file of a directory soft-delete and fell back to
 * mtime — which a move preserves, so a directory of old files was purgeable
 * the instant it was trashed, defeating the restore window exactly when a
 * bulk cleanup made it matter most. Resolve the nearest recorded ancestor
 * before giving up on the index.
 *
 * @returns the recorded trash time in ms, or null when nothing covers the path.
 */
export function trashedAtFor(
  originalRepoRelativePath: string,
  trashedAt: ReadonlyMap<string, number>
): number | null {
  const segments = originalRepoRelativePath.split('/').filter(Boolean);
  for (let depth = segments.length; depth > 0; depth -= 1) {
    const candidate = segments.slice(0, depth).join('/');
    const recorded = trashedAt.get(candidate);
    if (recorded !== undefined) return recorded;
  }
  return null;
}
