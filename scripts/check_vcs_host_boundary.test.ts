import { describe, expect, it } from 'vitest';
import {
  checkVcsHostBoundary,
  GH_EXEC_ALLOWLIST,
  scanVcsHostBoundary,
  SYNC_GH_MODULE,
} from './check_vcs_host_boundary.js';

const rules = (file: string, source: string) =>
  scanVcsHostBoundary(file, source).map((finding) => finding.rule);

describe('check:vcs-host-boundary', () => {
  it('flags a direct gh exec outside the allowlist', () => {
    expect(rules('libs/core/x.ts', "safeExecResult('gh', ['pr', 'list']);")).toEqual(['gh-exec']);
    expect(rules('scripts/x.ts', 'runner(`gh`, args);')).toEqual(['gh-exec']);
    expect(rules('scripts/x.ts', "this.exec.spawn('gh', args);")).toEqual(['gh-exec']);
  });

  it('ignores gh text that is not an exec', () => {
    expect(rules('libs/core/x.ts', "label.startsWith('gh') ? 'gh' : 'git';")).toEqual([]);
    expect(rules('libs/core/x.ts', "safeExec('git', ['status']); const bin = 'gh';")).toEqual([]);
    expect(rules('libs/core/x.ts', "seen.has('gh');")).toEqual([]);
  });

  it('allows gh execs in allowlisted files', () => {
    for (const file of Object.keys(GH_EXEC_ALLOWLIST)) {
      expect(rules(file, "run('gh', ['--version']);")).not.toContain('gh-exec');
    }
  });

  it('flags deprecated sync verbs by import, namespace access and call', () => {
    expect(rules('libs/core/x.ts', "import { ghPrCreate } from './vcs/github.js';")).toEqual([
      'sync-gh-verb',
    ]);
    expect(rules('scripts/x.ts', 'github.ghPrMerge({ ref: "1" });')).toEqual(['sync-gh-verb']);
    expect(rules('scripts/x.ts', 'type P = Parameters<typeof ghPrView>[0];')).toEqual([
      'sync-gh-verb',
    ]);
  });

  it('keeps the sync module, member names and supported sync helpers legal', () => {
    expect(rules(SYNC_GH_MODULE, 'export function ghPrCreate() { return ghMust([]); }')).toEqual(
      []
    );
    expect(rules('scripts/x.ts', 'const map = { ghPrCreate: 1 };')).toEqual([]);
    expect(
      rules('libs/core/x.ts', "import { ghVersion, ghAuthStatus } from './vcs/github.js';")
    ).toEqual([]);
    expect(rules('scripts/x.ts', 'ghRepositoryVisibility({}, run);')).toEqual(['sync-gh-verb']);
  });

  it('reports allowlist entries that no longer exec gh or no longer exist', () => {
    const findings = checkVcsHostBoundary([
      { file: SYNC_GH_MODULE, source: 'export const x = 1;' },
    ]).filter((finding) => finding.rule === 'stale-allowlist');
    expect(findings.map((finding) => finding.file).sort()).toEqual(
      Object.keys(GH_EXEC_ALLOWLIST).sort()
    );
    expect(findings.find((finding) => finding.file === SYNC_GH_MODULE)?.message).toMatch(
      /no longer executes gh/
    );
  });
});
