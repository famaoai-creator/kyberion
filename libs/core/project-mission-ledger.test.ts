import { afterEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync, safeSymlinkSync, safeWriteFile } from './secure-io.js';
import {
  loadProjectMissionLedgerAtPath,
  writeProjectMissionLedgerAtPath,
} from './project-mission-ledger.js';

const root = pathResolver.sharedTmp(`project-mission-ledger-${process.pid}`);

afterEach(() => {
  safeRmSync(root, { recursive: true, force: true });
});

const ledger = {
  project_id: 'project-a',
  project_name: 'Project A',
  entries: [
    {
      mission_id: 'MSN-1',
      relationship_type: 'supports' as const,
      status: 'active',
      summary: 'Keep the project ledger governed',
    },
  ],
};

describe('project mission ledger loader', () => {
  it('validates and reloads a ledger through the shared contract', () => {
    const file = path.join(root, 'mission-ledger.json');
    safeMkdir(root, { recursive: true });

    expect(writeProjectMissionLedgerAtPath(file, ledger)).toEqual(ledger);
    expect(loadProjectMissionLedgerAtPath(file)).toEqual(ledger);
  });

  it('fails closed for malformed ledgers', () => {
    const file = path.join(root, 'mission-ledger.json');
    safeMkdir(root, { recursive: true });
    safeWriteFile(file, JSON.stringify({ project_id: 'project-a', entries: 'invalid' }));

    expect(() => loadProjectMissionLedgerAtPath(file)).toThrow(
      /Invalid catalog project-mission-ledger/u
    );
  });

  it('rejects symlinked ledgers before JSON read', () => {
    const outside = path.join(root, 'outside');
    const link = path.join(root, 'mission-ledger.json');
    safeMkdir(outside, { recursive: true });
    safeWriteFile(path.join(outside, 'real.json'), JSON.stringify(ledger));
    safeSymlinkSync(path.join(outside, 'real.json'), link);

    expect(() => loadProjectMissionLedgerAtPath(link)).toThrow('[RESOURCE_PATH_SYMLINK]');
  });
});
