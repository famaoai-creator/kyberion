/**
 * Vitest globalSetup: report test writes that land in live operational state.
 *
 * `active/` is the operator's real runtime tree (missions, audit, ops alerts,
 * inbox, …). Tests must write to `active/shared/tmp/` or a `vitest-*`
 * redirect root (see `approvalStoreRoots`). The gitignored roots outside
 * `active/` hold live state too — the tenant registry and personal tier
 * (`knowledge/personal/`), tenant knowledge (`knowledge/confidential/`),
 * customer stance overlays (`customer/`) and the metrics ledgers
 * (`work/metrics/`) — and git status cannot see writes there. This guard snapshots every root in `LIVE_STATE_ROOTS` before the run
 * and, after it, lists every file the run created or grew outside the
 * sandboxes, so a new leak is visible instead of silently mixing fixture data
 * into an operator's mission list, audit trail or tenant registry.
 *
 * Attributed, not ignored: an agent session working in this checkout keeps
 * appending to live state through its hooks while the run it launched is in
 * progress. A grown file (same inode) whose appended rows ALL are stamped hook
 * rows (libs/core/provider/session-hook-provenance.ts: audit rows and the Stop
 * hook's metrics usage row) is listed under `session_hook_appends`; one other
 * or unparseable row reports the file, with the first such line's ordinal and
 * row kind under `grown_unattributed`. Created files are always reported,
 * except a lock under active/shared/runtime/locks/ that is gone when re-statted
 * at report time (`transient_locks`).
 *
 * Report: active/shared/tmp/vitest-active-leaks.json.
 * KYBERION_TEST_LEAK_STRICT=1 fails the run when anything leaked.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TENANT_AUDIT_MIRROR_ROOT_PATH } from '../libs/core/foundation/runtime-state-roots.js';
import { isSessionHookRow } from '../libs/core/provider/session-hook-provenance.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPORT = path.join(ROOT, 'active', 'shared', 'tmp', 'vitest-active-leaks.json');

/** Repo-relative roots holding live (gitignored) operator state a test run must not change. */
export const LIVE_STATE_ROOTS = [
  'active',
  'knowledge/personal',
  'knowledge/confidential',
  'customer',
  // Execution-metrics and resource-usage ledgers (the shared `metrics`
  // collector); path-resolver maps them into the Vitest live sandbox. The
  // tier/tenant-partitioned usage ledgers live under `active/` (covered above,
  // active/shared/runtime/usage-ledger/) and are sandboxed the same way.
  'work/metrics',
];

/** Repo-relative prefixes tests may write freely. */
export const TEST_SANDBOX_PREFIXES = [
  'active/shared/tmp/',
  'active/shared/cache/',
  'active/shared/runtime/vitest-',
];

/** Size and inode of every live file; an inode change means the file was replaced. */
type Snapshot = Map<string, { size: number; ino: number }>;

export function isSandboxed(relativePath: string): boolean {
  return TEST_SANDBOX_PREFIXES.some((prefix) => relativePath.startsWith(prefix));
}

export function snapshot(rootDir = ROOT, roots: readonly string[] = LIVE_STATE_ROOTS): Snapshot {
  const files: Snapshot = new Map();
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const relative = path.relative(rootDir, full).split(path.sep).join('/');
      if (entry.isDirectory()) {
        if (!isSandboxed(`${relative}/`)) walk(full);
      } else if (entry.isFile() && !isSandboxed(relative)) {
        try {
          const stat = fs.statSync(full);
          files.set(relative, { size: stat.size, ino: stat.ino });
        } catch {
          // Removed between readdir and stat: not ours to report.
        }
      }
    }
  };
  for (const root of roots) walk(path.join(rootDir, root));
  return files;
}

/** Live audit stores whose created files may hold only hook rows (a daily rollover). */
const AUDIT_STORE_PREFIXES = ['active/shared/logs/audit/', `${TENANT_AUDIT_MIRROR_ROOT_PATH}/`];
/** lock-utils LOCK_ROOT: every audit append and metrics-ledger append takes a lock here. */
const LOCK_DIR = 'active/shared/runtime/locks/';
const MAX_ATTRIBUTED_GROWTH_BYTES = 8 * 1024 * 1024;

/** Why an appended region was not attributed; no payload content, only the row kind. */
export interface UnattributedAppend {
  reason: string;
  /** 1-based ordinal of the first unattributed line within the appended region. */
  line?: number;
  agentId?: string;
  action?: string;
  component?: string;
}

function rowKind(row: unknown): Pick<UnattributedAppend, 'agentId' | 'action' | 'component'> {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) return {};
  const record = row as Record<string, unknown>;
  const pick = (key: string) =>
    typeof record[key] === 'string' ? { [key]: (record[key] as string).slice(0, 80) } : {};
  return { ...pick('agentId'), ...pick('action'), ...pick('component') };
}

/**
 * Classify the bytes a file gained between the two snapshots: undefined when
 * every appended row was written by an agent session's hooks (an audit row or
 * the Stop hook's metrics usage row, session-hook-provenance.ts), otherwise
 * why not. The session that launched the run keeps appending while the run is
 * in progress (PostToolUse for its own Bash call and any parallel tool call,
 * UserPromptSubmit / Stop, e.g. after it ends a turn during a background run).
 * Only the appended region is read. Fails closed: an unreadable or oversized
 * region, one not starting at a line boundary, a line that does not parse, or
 * any row that is not an attributed hook row.
 */
export function inspectAppendedRegion(
  absolutePath: string,
  previousSize: number,
  size: number
): UnattributedAppend | undefined {
  const length = size - previousSize;
  if (previousSize < 0 || length <= 0) return { reason: 'no appended region' };
  // Hook rows are under 1 KiB each; growth beyond the cap is reported unread.
  if (length > MAX_ATTRIBUTED_GROWTH_BYTES) return { reason: 'appended region above 8 MiB' };
  let region: Buffer;
  try {
    const fd = fs.openSync(absolutePath, 'r');
    try {
      region = Buffer.alloc(length);
      if (fs.readSync(fd, region, 0, length, previousSize) !== length) {
        return { reason: 'appended region unreadable' };
      }
      if (previousSize > 0) {
        // The region must begin a new line, or it continues a row we never saw whole.
        const prior = Buffer.alloc(1);
        if (
          fs.readSync(fd, prior, 0, 1, previousSize - 1) !== 1 ||
          (prior[0] !== 0x0a && region[0] !== 0x0a)
        ) {
          return { reason: 'appended region does not start at a line boundary' };
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { reason: 'file unreadable' };
  }
  const text = region.toString('utf8');
  if (!text.endsWith('\n')) return { reason: 'appended region ends mid-line' };
  let rows = 0;
  let ordinal = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    ordinal += 1;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      return { reason: 'line does not parse', line: ordinal };
    }
    if (!isSessionHookRow(row)) {
      return {
        reason: 'row is not an attributed session-hook row',
        line: ordinal,
        ...rowKind(row),
      };
    }
    rows += 1;
  }
  return rows > 0 ? undefined : { reason: 'no rows in appended region' };
}

/** Whether every byte a file gained is attributed session-hook rows ({@link inspectAppendedRegion}). */
export function grewOnlyBySessionHooks(
  absolutePath: string,
  previousSize: number,
  size: number
): boolean {
  return inspectAppendedRegion(absolutePath, previousSize, size) === undefined;
}

/** Group leaked paths by their first four segments so the report stays readable. */
export function summarizeLeaks(before: Snapshot, after: Snapshot, rootDir = ROOT) {
  const created: string[] = [];
  const grown: string[] = [];
  const sessionHookAppends: string[] = [];
  const transientLocks: string[] = [];
  const unattributed: Record<string, UnattributedAppend> = {};
  for (const [file, { size, ino }] of after) {
    const previous = before.get(file);
    if (previous === undefined) {
      // A lock taken during the run and released since is not persistent state:
      // re-stat it now. A lock that still exists stays reported.
      if (file.startsWith(LOCK_DIR) && !fs.existsSync(path.join(rootDir, file))) {
        transientLocks.push(file);
      } else created.push(file);
    } else if (size > previous.size) {
      const verdict =
        ino !== previous.ino
          ? { reason: 'file was replaced (inode changed), not appended to' }
          : inspectAppendedRegion(path.join(rootDir, file), previous.size, size);
      if (verdict === undefined) sessionHookAppends.push(file);
      else {
        grown.push(file);
        unattributed[file] = verdict;
      }
    }
  }
  // Still leaks (fail closed), but named so the reader knows the likely cause:
  // a new audit daily file (UTC date rollover) or the first audit file of a
  // fresh checkout, created mid-run by the session's hooks (master chain and,
  // for a tenant-bound session, its tenant mirror).
  const createdSessionHookOnly = created.filter(
    (file) =>
      AUDIT_STORE_PREFIXES.some((prefix) => file.startsWith(prefix)) &&
      grewOnlyBySessionHooks(path.join(rootDir, file), 0, after.get(file)?.size ?? 0)
  );
  const byArea: Record<string, number> = {};
  for (const file of [...created, ...grown]) {
    const area = file.split('/').slice(0, 4).join('/');
    byArea[area] = (byArea[area] ?? 0) + 1;
  }
  return {
    created: created.sort(),
    grown: grown.sort(),
    by_area: byArea,
    // Per reported grown file: why its appended region was not attributed.
    grown_unattributed: unattributed,
    // Not leaks: files that grew only by stamped agent-session hook rows.
    session_hook_appends: sessionHookAppends.sort(),
    // Not leaks: locks created during the run and gone at report time.
    transient_locks: transientLocks.sort(),
    created_session_hook_only: createdSessionHookOnly.sort(),
  };
}

export default function setup(): () => void {
  const before = snapshot();
  return () => {
    const leaks = summarizeLeaks(before, snapshot());
    const total = leaks.created.length + leaks.grown.length;
    try {
      fs.mkdirSync(path.dirname(REPORT), { recursive: true });
      fs.writeFileSync(REPORT, JSON.stringify(leaks, null, 2));
    } catch {
      // The report is advisory; never fail teardown on it.
    }
    if (total === 0) return;
    const areas = Object.entries(leaks.by_area)
      .sort((a, b) => b[1] - a[1])
      .map(([area, count]) => `  ${count}\t${area}`)
      .join('\n');
    const details = Object.entries(leaks.grown_unattributed)
      .map(
        ([file, d]) =>
          `  grown ${file}: ${d.reason}` +
          (d.line ? ` (appended line ${d.line}` : '') +
          [
            d.agentId && ` agentId=${d.agentId}`,
            d.action && ` action=${d.action}`,
            d.component && ` component=${d.component}`,
          ]
            .filter(Boolean)
            .join('') +
          (d.line ? ')' : '')
      )
      .join('\n');
    const rollover = leaks.created_session_hook_only.length
      ? `note: ${leaks.created_session_hook_only.join(', ')} contain(s) only agent-session hook rows — ` +
        `most likely an audit daily-file rollover (UTC midnight) or the first audit file of a fresh checkout ` +
        `created by the session's hooks during the run, not a test leak; rerun to confirm (still counted here)\n`
      : '';
    process.stderr.write(
      `\n[vitest-active-leak-guard] tests wrote ${total} file(s) into live state (${LIVE_STATE_ROOTS.join('/, ')}/) ` +
        `(created ${leaks.created.length}, grown ${leaks.grown.length}) — ` +
        `redirect them to active/shared/tmp/, a vitest-* root or a fixture root | evidence: ${path.relative(ROOT, REPORT)}\n${areas}\n${details ? `${details}\n` : ''}${rollover}`
    );
    if (process.env.KYBERION_TEST_LEAK_STRICT === '1') {
      throw new Error(
        `[vitest-active-leak-guard] ${total} live-state write(s) from tests` +
          (leaks.created_session_hook_only.length
            ? ` (${leaks.created_session_hook_only.length} created audit file(s) hold only session-hook rows — likely a daily rollover; rerun)`
            : '')
      );
    }
  };
}
