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
 * Report: active/shared/tmp/vitest-active-leaks.json.
 * KYBERION_TEST_LEAK_STRICT=1 fails the run when anything leaked.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const REPORT = path.join(ROOT, 'active', 'shared', 'tmp', 'vitest-active-leaks.json');

/** Repo-relative roots holding live (gitignored) operator state a test run must not change. */
export const LIVE_STATE_ROOTS = [
  'active',
  'knowledge/personal',
  'knowledge/confidential',
  'customer',
  // Execution-metrics and resource-usage ledgers (the shared `metrics`
  // collector); path-resolver maps them into the Vitest live sandbox.
  'work/metrics',
];

/** Repo-relative prefixes tests may write freely. */
export const TEST_SANDBOX_PREFIXES = [
  'active/shared/tmp/',
  'active/shared/cache/',
  'active/shared/runtime/vitest-',
];

type Snapshot = Map<string, number>;

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
          files.set(relative, fs.statSync(full).size);
        } catch {
          // Removed between readdir and stat: not ours to report.
        }
      }
    }
  };
  for (const root of roots) walk(path.join(rootDir, root));
  return files;
}

/** Group leaked paths by their first four segments so the report stays readable. */
export function summarizeLeaks(before: Snapshot, after: Snapshot) {
  const created: string[] = [];
  const grown: string[] = [];
  for (const [file, size] of after) {
    const previous = before.get(file);
    if (previous === undefined) created.push(file);
    else if (size > previous) grown.push(file);
  }
  const byArea: Record<string, number> = {};
  for (const file of [...created, ...grown]) {
    const area = file.split('/').slice(0, 4).join('/');
    byArea[area] = (byArea[area] ?? 0) + 1;
  }
  return { created: created.sort(), grown: grown.sort(), by_area: byArea };
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
    process.stderr.write(
      `\n[vitest-active-leak-guard] tests wrote ${total} file(s) into live state (${LIVE_STATE_ROOTS.join('/, ')}/) ` +
        `(created ${leaks.created.length}, grown ${leaks.grown.length}) — ` +
        `redirect them to active/shared/tmp/, a vitest-* root or a fixture root | evidence: ${path.relative(ROOT, REPORT)}\n${areas}\n`
    );
    if (process.env.KYBERION_TEST_LEAK_STRICT === '1') {
      throw new Error(`[vitest-active-leak-guard] ${total} live-state write(s) from tests`);
    }
  };
}
