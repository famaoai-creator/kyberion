import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { readJson, writeJson } from '../foundation/json.js';
import { withLockSync } from '../foundation/lock-utils.js';
import { logger } from '../core.js';
import { safeExistsSync, safeMkdir, safeMoveSync, safeRmSync, safeRealpath } from '../secure-io.js';

export const PLUGIN_PUBLICATION_DIRECTORY = '.kyberion-publications';
interface PublicationJournal {
  version: 1;
  phase: 'prepared' | 'committed';
  old: string | null;
  next: string;
}
function publicationKey(target: string): string {
  const resolved = path.join(safeRealpath(path.dirname(target)), path.basename(target));
  // Conservatively serialize case aliases on platforms commonly using a
  // case-insensitive volume; distinct case-sensitive names may share a lock.
  return process.platform === 'darwin' || process.platform === 'win32'
    ? resolved.toLowerCase()
    : resolved;
}
function publicationPaths(target: string) {
  const canonicalTarget = path.join(safeRealpath(path.dirname(target)), path.basename(target));
  const root = path.join(
    path.dirname(canonicalTarget),
    PLUGIN_PUBLICATION_DIRECTORY,
    createHash('sha256').update(publicationKey(target)).digest('hex')
  );
  return {
    root,
    journal: path.join(root, 'journal.json'),
    backup: path.join(root, 'previous'),
    candidate: path.join(root, 'candidate'),
  };
}
export function withPluginPublicationLock<T>(target: string, run: () => T): T {
  return withLockSync(`managed-plugin:${publicationKey(target)}`, run);
}

/** Must run under the same plugin lock. Unknown bytes are never overwritten during recovery. */
export function recoverPluginPublication(
  target: string,
  fingerprint: (dir: string) => string
): void {
  const paths = publicationPaths(target);
  if (!safeExistsSync(paths.journal)) return;
  const row = readJson<PublicationJournal>(paths.journal);
  if (
    row.version !== 1 ||
    !['prepared', 'committed'].includes(row.phase) ||
    !/^[a-f0-9]{64}$/.test(row.next) ||
    !(row.old === null || /^[a-f0-9]{64}$/.test(row.old))
  ) {
    throw new Error('[PLUGIN_PUBLICATION_RECOVERY_REQUIRED] Invalid publication journal');
  }
  const current = safeExistsSync(target) ? fingerprint(target) : null;
  const previous = safeExistsSync(paths.backup) ? fingerprint(paths.backup) : null;
  if (row.phase === 'committed') {
    if (current !== row.next || (previous !== null && previous !== row.old)) {
      throw new Error('[PLUGIN_PUBLICATION_RECOVERY_REQUIRED] Committed plugin changed');
    }
  } else if (previous !== null) {
    if (previous !== row.old || (current !== null && current !== row.next)) {
      throw new Error(
        '[PLUGIN_PUBLICATION_RECOVERY_REQUIRED] Recovery encountered unknown plugin bytes'
      );
    }
    if (current !== null) safeRmSync(target);
    safeMoveSync(paths.backup, target);
  } else if (row.old === null) {
    if (current !== null && current !== row.next)
      throw new Error('[PLUGIN_PUBLICATION_RECOVERY_REQUIRED] New target changed');
    if (current !== null) safeRmSync(target);
  } else if (current !== row.old) {
    throw new Error('[PLUGIN_PUBLICATION_RECOVERY_REQUIRED] Previous plugin is unavailable');
  }
  safeRmSync(paths.root);
}

/** Publish code and its install/approval record together. Caller holds the plugin lock. */
export function publishPluginDirectory(input: {
  target: string;
  staged: string;
  expectedPrevious: string | null;
  fingerprint: (dir: string) => string;
}): void {
  const { target, staged, expectedPrevious, fingerprint } = input;
  const paths = publicationPaths(target);
  const current = safeExistsSync(target) ? fingerprint(target) : null;
  if (current !== expectedPrevious)
    throw new Error(
      '[PLUGIN_PUBLICATION_CONFLICT] Installed plugin changed while preparing update'
    );
  safeMkdir(paths.root, { recursive: true });
  // These paths are reserved installer internals and are never discovered as plugins.
  safeRmSync(paths.candidate);
  safeMoveSync(staged, paths.candidate);
  const row: PublicationJournal = {
    version: 1,
    phase: 'prepared',
    old: current,
    next: fingerprint(paths.candidate),
  };
  writeJson(paths.journal, row);
  try {
    if (current !== null) safeMoveSync(target, paths.backup);
    safeMoveSync(paths.candidate, target);
    writeJson<PublicationJournal>(paths.journal, { ...row, phase: 'committed' });
  } catch (error) {
    recoverPluginPublication(target, fingerprint);
    throw error;
  }
  try {
    recoverPluginPublication(target, fingerprint);
  } catch (error) {
    // Publication already committed. A cleanup failure must not be reported
    // as a failed update; the durable journal makes the next install recover it.
    logger.warn(
      `[plugin-publication] committed plugin cleanup pending — ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
