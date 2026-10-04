import { describe, expect, it, vi } from 'vitest';
import { runInExecutionScope } from '../foundation/execution-scope.js';
import type { DotCharter } from '../dot/dot-charter.js';
import type { DotActionRecord } from '../dot/dot-dispatch.js';
import type { DotOutcomeRow, KrMeasurementRow } from '../dot/dot-state-paths.js';
import type { OrganizationCadenceDeps } from './organization-standup.js';
import {
  buildOrganizationRetro,
  renderOrganizationRetroText,
  runOrganizationRetro,
  type OrganizationRetroDeps,
} from './organization-retro.js';

const NOW = new Date('2026-10-09T08:00:00.000Z');
const SINCE = new Date('2026-10-02T08:00:00.000Z');
const scope = {
  organizationId: 'org-a',
  tier: 'confidential' as const,
  tenantSlug: 'acme',
  name: 'Acme',
};

const outcome = (verdict: DotOutcomeRow['verdict'], measured_at: string): DotOutcomeRow => ({
  dot_id: 'dot-1',
  action_ref: 'a',
  work_item_id: 'w',
  ref: { kr_id: 'kr-1' },
  verdict,
  due_at: measured_at,
  measured_at,
});

const kr = (progress: number, measured_at: string): KrMeasurementRow => ({
  scope: 'org',
  organization_id: 'org-a',
  objective_id: 'obj-1',
  kr_id: 'kr-1',
  value: progress,
  progress,
  measured_at,
});

function deps(overrides: Partial<OrganizationRetroDeps> = {}): OrganizationRetroDeps {
  return {
    now: () => NOW,
    listCharters: () => [
      {
        path: 'dots/dot-1.json',
        charter: {
          dot_id: 'dot-1',
          scope: { tier: 'confidential', tenant_slug: 'acme', organization_id: 'org-a' },
        } as DotCharter,
      },
    ],
    readActionLedger: () =>
      [
        {
          action_ref: 'a1',
          dot_id: 'dot-1',
          title: 'Delete prod',
          status: 'refused',
          reason: 'never_auto',
          at: '2026-10-05T00:00:00.000Z',
        },
        {
          action_ref: 'a2',
          dot_id: 'dot-1',
          title: 'Old',
          status: 'declined',
          at: '2026-09-01T00:00:00.000Z',
        },
      ] as DotActionRecord[],
    readOutcomes: () => [
      outcome('improved', '2026-10-05T00:00:00.000Z'),
      outcome('improved', '2026-10-06T00:00:00.000Z'),
      outcome('regressed', '2026-10-07T00:00:00.000Z'),
      outcome('regressed', '2026-08-01T00:00:00.000Z'),
    ],
    listIncidents: () =>
      [
        {
          incident_id: 'i1',
          title: 'Outage',
          severity: 'high',
          status: 'detected',
          created_at: '2026-10-06T00:00:00.000Z',
        },
        {
          incident_id: 'i0',
          title: 'Ancient',
          severity: 'low',
          status: 'closed',
          created_at: '2026-01-01T00:00:00.000Z',
        },
      ] as never,
    evaluateBudget: () =>
      ({
        throttle: 'soft',
        usage: { tokens: 2_500_000 },
        cap: { daily_token_cap: 3_000_000 },
      }) as never,
    readKrMeasurements: () => [
      kr(0.4, '2026-09-20T00:00:00.000Z'),
      kr(0.7, '2026-10-06T00:00:00.000Z'),
    ],
    loadPurpose: () =>
      ({
        objectives: [{ objective_id: 'obj-1', title: 'Grow', key_results: [{ kr_id: 'kr-1' }] }],
      }) as never,
    ...overrides,
  };
}

describe('buildOrganizationRetro', () => {
  it('summarises the window', () => {
    const retro = buildOrganizationRetro(scope, SINCE, deps());
    expect(retro.objectives).toEqual([
      expect.objectContaining({ objective_id: 'obj-1', before: 40, after: 70, delta: 30 }),
    ]);
    expect(retro.outcomes).toMatchObject({ improved: 2, regressed: 1, success_percent: 67 });
    expect(retro.rejections).toEqual([
      expect.objectContaining({ status: 'refused', title: 'Delete prod', reason: 'never_auto' }),
    ]);
    expect(retro.incidents.map((i) => i.incident_id)).toEqual(['i1']);
    expect(retro.budget).toEqual({ throttle: 'soft', tokens: 2_500_000, cap: 3_000_000 });
    expect(retro.quiet).toBe(false);
  });

  it('reads the outcomes ledger tolerantly when the ledger is missing', () => {
    const retro = buildOrganizationRetro(
      scope,
      SINCE,
      deps({
        readOutcomes: undefined,
        rootDir: '/nonexistent-root-for-test',
      } as Partial<OrganizationCadenceDeps>)
    );
    expect(retro.outcomes).toMatchObject({ improved: 0, regressed: 0 });
  });

  it('is quiet with no objectives movement, outcomes, rejections, incidents or pressure', () => {
    const retro = buildOrganizationRetro(
      scope,
      SINCE,
      deps({
        readActionLedger: () => [],
        readOutcomes: () => [],
        listIncidents: () => [],
        readKrMeasurements: () => [],
        evaluateBudget: () =>
          ({ throttle: 'normal', usage: { tokens: 1 }, cap: { daily_token_cap: 3 } }) as never,
      })
    );
    expect(retro.quiet).toBe(true);
  });
});

describe('renderOrganizationRetroText', () => {
  it('renders en and ja', () => {
    const retro = buildOrganizationRetro(scope, SINCE, deps());
    expect(renderOrganizationRetroText(retro, 'Acme', 'en')).toContain(
      'Did actions move the signals?'
    );
    const ja = renderOrganizationRetroText(retro, 'Acme', 'ja');
    expect(ja).toContain('*週次ふりかえり* Acme');
    expect(ja).toContain('成功率67%');
  });
});

describe('runOrganizationRetro', () => {
  it('is sovereign-only', () => {
    expect(() => runOrganizationRetro({ env: { KYBERION_PERSONA: 'x' } }, deps())).toThrow(
      /requires KYBERION_PERSONA=sovereign/
    );
  });

  it('files, notifies and audits', () => {
    const writeArtifact = vi.fn().mockReturnValue({ repo_relative_path: 'p.json' });
    const notify = vi.fn().mockReturnValue(true);
    const audit = vi.fn();
    const result = runOrganizationRetro(
      { env: { KYBERION_PERSONA: 'sovereign' }, locale: 'en' },
      {
        ...deps(),
        writeArtifact: writeArtifact as never,
        notify,
        audit,
        listOrganizations: (tier) => (tier === 'confidential' ? [scope] : []),
      }
    );
    expect(result.reported_count).toBe(1);
    expect(writeArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'retros/2026-10-09.json', artifact_class: 'report' })
    );
    expect(notify).toHaveBeenCalledWith(
      'decision_digest',
      expect.objectContaining({ correlation_id: 'org-retro-org-a-2026-10-09' }),
      { route: { surface: 'inbox', target: 'organization-retro' } }
    );
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'organization.retro' }));
  });
});

describe('runOrganizationRetro scoped mode', () => {
  const cadenceScope = {
    tier: 'confidential' as const,
    tenantSlug: 'acme',
    organizationId: 'org-a',
  };
  const bound = <T>(tenantSlug: string, fn: () => T): T =>
    runInExecutionScope(
      {
        tenantBound: true,
        tenantSlug,
        assumedRole: 'organization_operator',
        assumedPersona: null,
      },
      fn
    );

  it('runs for the bound tenant without the sovereign persona and audits retro:scoped', () => {
    const audit = vi.fn();
    const other = { ...scope, organizationId: 'org-b' };
    const result = bound('acme', () =>
      runOrganizationRetro(
        { scope: cadenceScope, persist: false, locale: 'en', env: { KYBERION_PERSONA: 'worker' } },
        { ...deps(), audit, listOrganizations: () => [scope, other] }
      )
    );
    expect(result.organization_count).toBe(1);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'retro:scoped',
        tenantSlug: 'acme',
        agentId: 'organization_operator',
      })
    );
  });

  it('refuses a mismatched bound tenant', () => {
    expect(() =>
      bound('other', () =>
        runOrganizationRetro(
          { scope: cadenceScope, persist: false },
          { ...deps(), listOrganizations: () => [scope] }
        )
      )
    ).toThrow(/POLICY_VIOLATION/);
  });
});
