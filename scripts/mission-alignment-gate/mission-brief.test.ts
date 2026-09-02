import { afterEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import { loadMissionBriefAtPath } from './mission-brief.js';

const root = pathResolver.sharedTmp(`mission-brief-loader-${process.pid}`);

afterEach(() => {
  safeRmSync(root, { recursive: true, force: true });
});

function writeBrief(value: unknown): string {
  safeMkdir(root, { recursive: true });
  const filePath = path.join(root, 'mission-brief.json');
  safeWriteFile(filePath, JSON.stringify(value), { encoding: 'utf8' });
  return filePath;
}

describe('mission brief canonical loader', () => {
  it('loads a partial brief and preserves example-compatible scalar types', () => {
    const filePath = writeBrief({
      missionId: 'MSN-LOADER',
      gate: { sudoGate: false, riskLevel: 3 },
      risks: [{ risk: 'drift', level: 3 }],
    });

    expect(loadMissionBriefAtPath(filePath)).toEqual({
      missionId: 'MSN-LOADER',
      gate: { sudoGate: false, riskLevel: 3 },
      risks: [{ risk: 'drift', level: 3 }],
    });
  });

  it('rejects unknown fields before a brief can be approved or rendered', () => {
    const filePath = writeBrief({ missionId: 'MSN-LOADER', unexpected: true });

    expect(() => loadMissionBriefAtPath(filePath)).toThrow(/Invalid catalog mission-brief/u);
  });
});
