import * as path from 'node:path';

/** Content of a file write, when the caller writes whole bytes (secure-io `safeWriteFile`). */
export type WriteContent = string | Buffer;

/**
 * Stores whose rules are content rules (CD-09 / CD-10): the tier guard checks
 * each write made inside their live grant (G2: no role) against the file on
 * disk, so a process that calls secure-io directly is held to the same rules as
 * the store. A write without content (append, copy, rename, link, unlink) is
 * refused for them.
 */
export type ContentCheckedStore = 'consumer' | 'milestone';

/** A record problem: `relative` is the case-relative path; null when the change is allowed. */
export type CaseRecordWriteProblem = (
  relative: string,
  previous: unknown,
  next: unknown,
  readCaseFile: (relative: string) => string | undefined
) => string | null;

/** An unparseable record: never undefined (that would read as "absent"). */
function parseJsonOrInvalid(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * The refusal reason of a content-checked store's write, or null when allowed.
 * `caseDir` is the case directory of the store's capability (repo-relative);
 * `readRepoFile` reads a repo-relative file raw (undefined when absent) — the
 * guard's own read, outside any caller scope. Dependency-free so each grant
 * module registers its own content check (G3) without importing the others.
 */
export function caseRecordWriteDenial(
  store: ContentCheckedStore,
  problem: CaseRecordWriteProblem,
  relativePath: string,
  content: WriteContent | undefined,
  caseDir: string | undefined,
  readRepoFile: (repoRelative: string) => string | undefined
): string | null {
  const prefix = caseDir ? `${caseDir}/` : '';
  if (content === undefined || !caseDir || !relativePath.startsWith(prefix))
    return `[CUSTOMER_DECISION_WRITE_CONTENT_REQUIRED] the customer decision ${store} store writes only whole records whose content the guard checks`;
  const readCaseFile = (relative: string) => readRepoFile(path.posix.join(caseDir, relative));
  const relative = relativePath.slice(prefix.length);
  let previous: unknown;
  try {
    const onDisk = readCaseFile(relative);
    previous = onDisk === undefined ? undefined : parseJsonOrInvalid(onDisk);
  } catch {
    return '[CUSTOMER_DECISION_WRITE_CONTENT_REQUIRED] the record on disk could not be read for the content check';
  }
  const next = parseJsonOrInvalid(typeof content === 'string' ? content : content.toString('utf8'));
  return problem(relative, previous, next, readCaseFile);
}
