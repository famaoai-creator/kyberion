import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pathResolver, safeMkdir, safeRmSync, safeWriteFile } from '@agent/core';
import { LIVE_STATE_ROOTS, snapshot, summarizeLeaks } from './vitest-active-leak-guard.js';

const FIXTURE_ROOT = pathResolver.sharedTmp(`vitest-leak-guard-${process.pid}`);

function write(relative: string, content = 'x'): void {
  const file = path.join(FIXTURE_ROOT, relative);
  safeMkdir(path.dirname(file), { recursive: true });
  safeWriteFile(file, content);
}

describe('vitest live-state leak guard', () => {
  beforeEach(() => {
    safeRmSync(FIXTURE_ROOT, { recursive: true, force: true });
    write('active/missions/existing.json');
    write('knowledge/personal/README.md');
  });

  afterEach(() => {
    safeRmSync(FIXTURE_ROOT, { recursive: true, force: true });
  });

  it('snapshots the gitignored live roots outside active/', () => {
    expect(LIVE_STATE_ROOTS).toEqual(
      expect.arrayContaining(['active', 'knowledge/personal', 'knowledge/confidential', 'customer'])
    );
  });

  it('reports files created in the tenant registry and customer overlays', () => {
    const before = snapshot(FIXTURE_ROOT);
    write('knowledge/personal/tenants/default.json', '{}');
    write('knowledge/confidential/probe-co/notes.md');
    write('customer/probe-co/customer.json');
    write('active/shared/tmp/scratch.json');
    write('knowledge/public/ignored.md');

    const leaks = summarizeLeaks(before, snapshot(FIXTURE_ROOT));

    expect(leaks.created).toEqual([
      'customer/probe-co/customer.json',
      'knowledge/confidential/probe-co/notes.md',
      'knowledge/personal/tenants/default.json',
    ]);
    expect(leaks.grown).toEqual([]);
    expect(leaks.by_area).toEqual({
      'customer/probe-co/customer.json': 1,
      'knowledge/confidential/probe-co/notes.md': 1,
      'knowledge/personal/tenants/default.json': 1,
    });
  });

  it('reports a tracked personal-tier file that grew', () => {
    const before = snapshot(FIXTURE_ROOT);
    write('knowledge/personal/README.md', 'grown');

    expect(summarizeLeaks(before, snapshot(FIXTURE_ROOT)).grown).toEqual([
      'knowledge/personal/README.md',
    ]);
  });
});
