import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCOPE_AFFINITY,
  docAuthorityScore,
  knowledgeMetadataScore,
  recencyDecayScore,
  scopeAffinityScore,
  scopeContextFromKnowledgePath,
  scopeProximityScore,
} from './ranking-signals.js';

describe('ranking-signals (KM-02)', () => {
  it('scopeAffinityScore matches the historical matrix values', () => {
    expect(scopeAffinityScore('mission', 'repository', 12)).toBe(Math.round(12 * 0.8));
    expect(scopeAffinityScore('global', 'environment', 12)).toBe(Math.round(12 * 0.2));
    expect(scopeAffinityScore('mission', 'mission', 12)).toBe(12);
  });

  it('scopeAffinityScore falls back to 0.4 for unknown scopes', () => {
    expect(scopeAffinityScore('mystery', 'mission', 10)).toBe(4);
    expect(scopeAffinityScore('mission', 'mystery', 10)).toBe(4);
  });

  it('docAuthorityScore walks the policy > standard > recipe > reference > advisory ladder', () => {
    expect(docAuthorityScore('policy', 8)).toBe(8);
    expect(docAuthorityScore('standard', 8)).toBe(7);
    expect(docAuthorityScore('recipe', 8)).toBe(6);
    expect(docAuthorityScore('reference', 8)).toBe(4);
    expect(docAuthorityScore('advisory', 8)).toBe(3);
    expect(docAuthorityScore('unknown-level', 8)).toBe(0);
  });

  it('docAuthorityScore never drops a recognised level below 1', () => {
    expect(docAuthorityScore('advisory', 2)).toBe(1);
    expect(docAuthorityScore('policy', 0)).toBe(0);
  });

  it('recencyDecayScore loses one point per 30 days and floors at 0', () => {
    const now = Date.UTC(2026, 6, 12);
    const day = 24 * 3600 * 1000;
    expect(recencyDecayScore(now, now)).toBe(10);
    expect(recencyDecayScore(now - 30 * day, now)).toBe(9);
    expect(recencyDecayScore(now - 600 * day, now)).toBe(0);
  });

  it('recencyDecayScore treats invalid dates as no recency signal (was NaN)', () => {
    expect(recencyDecayScore(Number.NaN, Date.now())).toBe(0);
  });

  it('exposes the affinity matrix for callers that need to extend it', () => {
    expect(DEFAULT_SCOPE_AFFINITY.repository.mission).toBe(0.8);
  });

  it('scores runtime knowledge metadata with the same authority, scope, and recency signals', () => {
    const now = Date.UTC(2026, 6, 12);
    const policy = knowledgeMetadataScore(
      { doc_authority: 'policy', scope: 'repository', last_updated: '2026-07-12' },
      'repository',
      {},
      now
    );
    const advisory = knowledgeMetadataScore(
      { doc_authority: 'advisory', scope: 'repository', last_updated: '2026-07-12' },
      'repository',
      {},
      now
    );
    expect(policy).toBeGreaterThan(advisory);
  });

  it('keeps legacy hints neutral when metadata is absent', () => {
    expect(knowledgeMetadataScore({}, 'mission', {}, Date.UTC(2026, 6, 12))).toBe(0);
  });
});

describe('scope proximity ranking', () => {
  const current = {
    tier: 'confidential' as const,
    tenant_slug: 'acme-corp',
    organization_id: 'org-a',
    project_id: 'project-a',
    mission_id: 'mission-a',
    task_id: 'task-a',
  };

  it('derives the physical containment chain from a knowledge path', () => {
    expect(
      scopeContextFromKnowledgePath(
        'confidential/acme-corp/organizations/org-a/projects/project-a/missions/mission-a/tasks/task-a/guide.md'
      )
    ).toMatchObject({
      tenant_slug: 'acme-corp',
      organization_id: 'org-a',
      project_id: 'project-a',
      mission_id: 'mission-a',
      task_id: 'task-a',
    });
  });

  it('uses a deterministic strict proximity ladder', () => {
    expect(
      scopeProximityScore(
        { tier: 'confidential', tenant_slug: 'acme-corp', project_id: 'project-a' },
        current
      )
    ).toBeGreaterThan(scopeProximityScore(undefined, current));
    expect(
      scopeProximityScore(
        { tier: 'confidential', tenant_slug: 'acme-corp', mission_id: 'mission-a' },
        current
      )
    ).toBeGreaterThan(
      scopeProximityScore(
        { tier: 'confidential', tenant_slug: 'acme-corp', project_id: 'project-a' },
        current
      )
    );
    expect(
      scopeProximityScore(
        { tier: 'confidential', tenant_slug: 'other-corp', project_id: 'project-a' },
        current
      )
    ).toBe(0);
  });
});
