import { afterEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeRmSync, safeSymlinkSync, safeWriteFile } from '@agent/core/secure-io';
import { loadTrustScores, scanMissions } from './mission_journal.js';

const root = pathResolver.sharedTmp(`mission-journal-loader-${process.pid}`);
const outside = pathResolver.sharedTmp(`mission-journal-loader-outside-${process.pid}`);

afterEach(() => {
  safeRmSync(root, { recursive: true, force: true });
  safeRmSync(outside, { recursive: true, force: true });
});

describe('mission journal resource boundary', () => {
  it('does not read a symlinked mission directory', () => {
    const linked = path.join(root, 'linked-mission');
    safeMkdir(outside, { recursive: true });
    safeWriteFile(
      path.join(outside, 'mission-state.json'),
      JSON.stringify({
        mission_id: 'MSN-LINKED',
        status: 'active',
        tier: 'confidential',
        history: [],
      })
    );
    safeSymlinkSync(outside, linked);

    expect(scanMissions(undefined, [root])).toEqual([]);
  });

  it('ignores primitive and malformed mission state records', () => {
    const malformed = path.join(root, 'malformed-mission');
    safeMkdir(malformed, { recursive: true });
    safeWriteFile(path.join(malformed, 'mission-state.json'), '[]');
    expect(scanMissions(undefined, [root])).toEqual([]);
  });

  it('projects only finite trust scores from a JSON object', () => {
    const ledger = path.join(root, 'trust-scores.json');
    safeWriteFile(
      ledger,
      JSON.stringify({
        agents: {
          'agent-a': { current_score: 850 },
          'agent-b': { current_score: 'unsafe' },
          'agent-c': { current_score: 1200 },
          'agent-d': [],
        },
      })
    );
    expect(loadTrustScores(ledger)).toEqual({ 'agent-a': 850 });
    safeWriteFile(ledger, '[]');
    expect(loadTrustScores(ledger)).toEqual({});
  });
});
