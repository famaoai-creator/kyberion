import { afterEach, describe, expect, it } from 'vitest';
import * as nodePath from 'node:path';
import {
  getWriterLeaseMetrics,
  resetWriterLeaseMetrics,
  writerLeaseResourceId,
} from './writer-lease.js';
import { safeReadFile, safeRmSync } from './secure-io.js';
import { writeDispatchArtifact } from './mission-dispatch-lifecycle.js';
import { pathResolver } from './path-resolver.js';

const missionPath = pathResolver.shared(`tmp/dispatch-artifact-lease-${process.pid}`);
const missionId = `MSN-DISPATCH-ARTIFACT-${process.pid}`;

afterEach(() => {
  safeRmSync(missionPath, { recursive: true, force: true });
  resetWriterLeaseMetrics();
});

describe('mission-dispatch-lifecycle', () => {
  it('fences every dispatch artifact write with the mission coordination lease', () => {
    const filePath = nodePath.join(missionPath, 'evidence', 'dispatch.json');
    const leasePath = nodePath.join(missionPath, 'coordination', 'writer-lease.json');

    writeDispatchArtifact(filePath, { status: 'first' }, { missionId, missionPath });
    writeDispatchArtifact(filePath, { status: 'second' }, { missionId, missionPath });

    expect(JSON.parse(String(safeReadFile(filePath, { encoding: 'utf8' })))).toEqual({
      status: 'second',
    });
    const receipts = String(
      safeReadFile(nodePath.join(missionPath, 'coordination', 'provisioned-entries.jsonl'), {
        encoding: 'utf8',
      })
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { phase: string });
    expect(receipts.map((receipt) => receipt.phase)).toEqual([
      'provisioned',
      'verified',
      'provisioned',
      'verified',
    ]);
    expect(getWriterLeaseMetrics(writerLeaseResourceId(leasePath))).toEqual([
      {
        resource_id: writerLeaseResourceId(leasePath),
        acquired: 2,
        renewed: 0,
        released: 2,
        rejected: 0,
      },
    ]);
  });

  it('fails closed when the canonical mission path is missing', () => {
    expect(() =>
      writeDispatchArtifact(
        'active/shared/tmp/dispatch-artifact.json',
        {},
        {
          missionId,
          missionPath: '  ',
        }
      )
    ).toThrow('[DISPATCH_ARTIFACT] missionPath is required');
  });
});
