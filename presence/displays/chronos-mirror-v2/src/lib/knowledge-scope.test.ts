import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { MemoryCandidate } from '@agent/core/memory-promotion-queue';
import { withExecutionContext } from '@agent/core/authority';
import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import { resolveMemoryCandidateTenant } from './knowledge-scope';

const missionIds: string[] = [];

function makeCandidate(missionId: string): MemoryCandidate {
  return {
    candidate_id: 'candidate-1',
    source_type: 'mission',
    source_ref: `mission:${missionId}`,
    proposed_memory_kind: 'heuristic',
    summary: 'summary',
    evidence_refs: [],
    sensitivity_tier: 'public',
    ratification_required: false,
    status: 'queued',
    queued_at: '2026-09-02T00:00:00.000Z',
  };
}

describe('chronos knowledge scope', () => {
  afterEach(() => {
    withExecutionContext('mission_controller', () => {
      for (const missionId of missionIds.splice(0)) {
        safeRmSync(pathResolver.missionDir(missionId, 'public'), { recursive: true, force: true });
      }
    });
  });

  it('resolves tenant identity only from schema-valid mission state', () => {
    const missionId = `KSCOPE-${process.pid}-${randomUUID().slice(0, 8)}`;
    missionIds.push(missionId);
    const missionDir = pathResolver.missionDir(missionId, 'public');
    withExecutionContext('mission_controller', () => {
      safeMkdir(missionDir, { recursive: true });
      safeWriteFile(
        path.join(missionDir, 'mission-state.json'),
        JSON.stringify({
          mission_id: missionId,
          tier: 'public',
          status: 'active',
          execution_mode: 'local',
          priority: 1,
          assigned_persona: 'operator',
          confidence_score: 1,
          tenant_slug: 'tenant-a',
          git: { branch: 'main', start_commit: 'a', latest_commit: 'b', checkpoints: [] },
          history: [],
        })
      );
    });

    expect(resolveMemoryCandidateTenant(makeCandidate(missionId))).toBe('tenant-a');
  });
});
