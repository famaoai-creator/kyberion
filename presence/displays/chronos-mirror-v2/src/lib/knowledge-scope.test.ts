import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { MemoryCandidate } from '@agent/core/knowledge/memory-promotion-queue';
import { withExecutionContext } from '@agent/core/authority';
import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import { resolveMemoryCandidateTenant, memoryCandidateVisibleToViewer } from './knowledge-scope';
import type { ViewerContext } from './viewer-context';

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

describe('memory source scope is not the promotion destination', () => {
  const viewer: ViewerContext = {
    role: 'localadmin',
    source: 'token',
    principalId: 'user:owner',
    tenantSlugs: 'all',
    organizationIds: 'all',
    projectIds: 'all',
    tierAccess: ['public', 'confidential'],
  };
  const candidate: MemoryCandidate = {
    ...makeCandidate('MSN-SOURCE'),
    sensitivity_tier: 'confidential',
    scope: { tier: 'personal', owner_nhi: 'user:owner' },
    summary: 'private source with conservative destination',
  };
  it('hides personal source despite confidential destination and all-tenant viewer', () => {
    expect(memoryCandidateVisibleToViewer(candidate, viewer)).toBe(false);
    expect(
      memoryCandidateVisibleToViewer(candidate, {
        ...viewer,
        tierAccess: ['personal', 'public', 'confidential'],
      })
    ).toBe(false);
    expect(
      memoryCandidateVisibleToViewer(
        { ...candidate, scope: { ...candidate.scope!, tenant_slug: 'acme' } },
        viewer
      )
    ).toBe(false);
  });
  it('requires both public source and confidential destination access', () => {
    const row = { ...candidate, scope: { tier: 'public' as const } };
    expect(memoryCandidateVisibleToViewer(row, viewer)).toBe(true);
    expect(memoryCandidateVisibleToViewer(row, { ...viewer, tierAccess: ['confidential'] })).toBe(
      false
    );
    expect(memoryCandidateVisibleToViewer(row, { ...viewer, tierAccess: ['public'] })).toBe(false);
  });
  it('checks canonical tenant, organization, project, owner and audience', () => {
    const scope = {
      tier: 'confidential' as const,
      tenant_slug: 'acme',
      organization_id: 'org-a',
      project_id: 'proj-a',
    };
    const scoped = {
      ...viewer,
      tenantSlugs: ['acme'],
      organizationIds: ['org-a'],
      projectIds: ['proj-a'],
    };
    expect(memoryCandidateVisibleToViewer({ ...candidate, scope }, scoped)).toBe(true);
    for (const change of [
      { tenant_slug: 'other' },
      { organization_id: 'org-b' },
      { project_id: 'proj-b' },
      { owner_nhi: 'user:other' },
      { allowed_audience: ['user:other'] },
    ])
      expect(
        memoryCandidateVisibleToViewer({ ...candidate, scope: { ...scope, ...change } }, scoped)
      ).toBe(false);
    expect(() =>
      memoryCandidateVisibleToViewer({ ...candidate, scope }, scoped, 'other')
    ).toThrow();
    expect(
      memoryCandidateVisibleToViewer(
        { ...candidate, scope: { tier: 'confidential', tenant_slug: 'acme' } },
        scoped
      )
    ).toBe(false);
  });
  it('denies malformed scope instead of treating it as destination-tier legacy', () => {
    expect(
      memoryCandidateVisibleToViewer(
        { ...candidate, scope: { tenant_slug: 'acme' } as MemoryCandidate['scope'] },
        viewer
      )
    ).toBe(false);
  });
});
