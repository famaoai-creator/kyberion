import { describe, expect, it, vi } from 'vitest';
import type { ScopeContext } from '@agent/core';
import { missionDetail, missionSummaryScope } from './missions.js';
import { makeI18n } from '../i18n.js';

const { statusView } = vi.hoisted(() => ({ statusView: vi.fn() }));
vi.mock('@agent/core/mission/mission-read-model', async (original) => ({
  ...(await original<typeof import('@agent/core/mission/mission-read-model')>()),
  buildMissionStatusView: statusView,
}));

function scope(overrides: Partial<ScopeContext> = {}): ScopeContext {
  return { scope_kind: 'system', tier: 'public', ...overrides };
}

describe('mission summary scope', () => {
  it('shows structural-only extraction in mission details without claiming review', () => {
    statusView.mockReturnValue({
      nextAction: 'Review evidence',
      state: {
        distillation: { mode: 'structural', llm_used: false, structural_reason: 'stub_requested' },
      },
      recentHistory: [],
    });
    const lines = missionDetail('MSN-TEST', makeI18n('en'));
    expect(lines).toContainEqual({
      label: 'Knowledge extraction',
      value: 'Structural extraction only (stub requested); no LLM extraction',
    });
    statusView.mockReturnValue({
      nextAction: 'Review evidence',
      state: { distillation: { status: 'completed' } },
      recentHistory: [],
    });
    expect(missionDetail('MSN-LEGACY', makeI18n('en'))).toContainEqual({
      label: 'Knowledge extraction',
      value: 'Extraction method unverified',
    });
  });

  it('keeps public shared reads available without a tenant', () => {
    expect(missionSummaryScope(scope())).toEqual({
      tier: 'public',
      tenantSlug: undefined,
      organizationId: undefined,
      projectId: undefined,
    });
  });

  it('fails closed for a confidential scope without a tenant', () => {
    expect(missionSummaryScope(scope({ tier: 'confidential' }))).toEqual({
      tier: 'confidential',
      tenantSlug: null,
      organizationId: undefined,
      projectId: undefined,
    });
  });
});
