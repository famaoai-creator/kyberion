import { describe, expect, it, vi } from 'vitest';
import { runInExecutionScope } from '../foundation/execution-scope.js';
import type { DotCharter, LoadedDotCharter } from '../dot/dot-charter.js';
import type { DotActionRecord } from '../dot/dot-dispatch.js';
import type { KrMeasurementRow } from '../dot/dot-state-paths.js';
import {
  buildOrganizationStandup,
  defaultStandupWindowHours,
  renderOrganizationStandupText,
  runOrganizationStandup,
  type OrganizationCadenceDeps,
} from './organization-standup.js';

const NOW = new Date('2026-10-05T00:00:00.000Z');
const SINCE = new Date('2026-10-04T00:00:00.000Z');
const scope = {
  organizationId: 'org-a',
  tier: 'confidential' as const,
  tenantSlug: 'acme',
  name: 'Acme',
};

const charter = (dotId: string, orgId = 'org-a'): LoadedDotCharter => ({
  path: `dots/${dotId}.json`,
  charter: {
    dot_id: dotId,
    scope: { tier: 'confidential', tenant_slug: 'acme', organization_id: orgId },
  } as DotCharter,
});

const action = (overrides: Partial<DotActionRecord>): DotActionRecord =>
  ({
    action_ref: 'a1',
    dot_id: 'dot-1',
    title: 'Ship it',
    status: 'dispatched',
    at: '2026-10-04T10:00:00.000Z',
    ...overrides,
  }) as DotActionRecord;

const measurement = (progress: number, measured_at: string): KrMeasurementRow => ({
  scope: 'org',
  organization_id: 'org-a',
  objective_id: 'obj-1',
  kr_id: 'kr-1',
  value: progress * 10,
  progress,
  measured_at,
});

function deps(overrides: Partial<OrganizationCadenceDeps> = {}): OrganizationCadenceDeps {
  return {
    now: () => NOW,
    listCharters: () => [charter('dot-1'), charter('dot-other', 'org-b')],
    readActionLedger: () => [
      action({}),
      action({
        action_ref: 'a2',
        status: 'parked',
        at: '2026-10-01T10:00:00.000Z',
        title: 'Old parked',
      }),
      action({ action_ref: 'a3', dot_id: 'dot-other' }),
      action({ action_ref: 'a4', status: 'dispatched', at: '2026-09-01T00:00:00.000Z' }),
    ],
    readWorkResults: (c) => [
      {
        dot_id: c.dot_id,
        work_item_id: 'w1',
        action_ref: 'a1',
        mode: 'delegated',
        status: 'done',
        summary: 'Merged the change',
        started_at: '2026-10-04T10:00:00.000Z',
        completed_at: '2026-10-04T11:00:00.000Z',
      },
    ],
    listOperationRuns: () => [
      {
        run_id: 'r1',
        operation_id: 'op-1',
        organization_id: 'org-a',
        tier: 'confidential',
        status: 'succeeded',
        started_at: '2026-10-04T09:00:00.000Z',
        completed_at: '2026-10-04T09:05:00.000Z',
        recorded_at: '2026-10-04T09:05:00.000Z',
      },
      {
        run_id: 'r0',
        operation_id: 'op-1',
        organization_id: 'org-a',
        tier: 'confidential',
        status: 'failed',
        started_at: '2026-09-01T09:00:00.000Z',
        recorded_at: '2026-09-01T09:00:00.000Z',
      },
    ],
    listDecisions: () =>
      [
        {
          decision_id: 'd1',
          title: 'Pick vendor',
          status: 'pending_approval',
          due_at: '2026-10-06T00:00:00.000Z',
        },
        {
          decision_id: 'd2',
          title: 'Done',
          status: 'approved',
          due_at: '2026-10-06T00:00:00.000Z',
        },
      ] as never,
    listBlockedWorkItems: () =>
      [
        {
          item_id: 'wi-1',
          title: 'Stuck',
          status: 'blocked',
          context: { organization_id: 'org-a', tenant_slug: 'acme' },
        },
        {
          item_id: 'wi-2',
          title: 'Elsewhere',
          status: 'blocked',
          context: { organization_id: 'org-b', tenant_slug: 'acme' },
        },
      ] as never,
    readKrMeasurements: () => [
      measurement(0.2, '2026-10-01T00:00:00.000Z'),
      measurement(0.5, '2026-10-04T12:00:00.000Z'),
    ],
    loadPurpose: () =>
      ({
        objectives: [
          { objective_id: 'obj-1', title: 'Grow', key_results: [{ kr_id: 'kr-1', weight: 1 }] },
        ],
      }) as never,
    ...overrides,
  };
}

describe('buildOrganizationStandup', () => {
  it('collects only this organization and window, keeping parked actions regardless of age', () => {
    const standup = buildOrganizationStandup(scope, SINCE, deps());
    expect(standup.operation_runs.map((r) => r.run_id)).toEqual(['r1']);
    expect(standup.dot_work).toEqual([
      expect.objectContaining({ dot_id: 'dot-1', status: 'done' }),
    ]);
    expect(standup.actions.map((a) => `${a.status}:${a.title}`).sort()).toEqual([
      'dispatched:Ship it',
      'parked:Old parked',
    ]);
    expect(standup.pending_decisions.map((d) => d.decision_id)).toEqual(['d1']);
    expect(standup.blocked_work_items.map((b) => b.item_id)).toEqual(['wi-1']);
    expect(standup.objective_changes).toEqual([
      expect.objectContaining({ objective_id: 'obj-1', before: 20, after: 50, delta: 30 }),
    ]);
    expect(standup.quiet).toBe(false);
  });

  it('is quiet when nothing happened', () => {
    const standup = buildOrganizationStandup(
      scope,
      SINCE,
      deps({
        listCharters: () => [],
        listOperationRuns: () => [],
        listDecisions: () => [],
        listBlockedWorkItems: () => [],
        readKrMeasurements: () => [],
        readActionLedger: () => [],
      })
    );
    expect(standup.quiet).toBe(true);
    expect(renderOrganizationStandupText(standup, 'Acme', 'en')).toContain(
      'Nothing to report since the last standup.'
    );
  });
});

describe('renderOrganizationStandupText', () => {
  it('renders en and ja sections', () => {
    const standup = buildOrganizationStandup(scope, SINCE, deps());
    const en = renderOrganizationStandupText(standup, 'Acme', 'en');
    expect(en).toContain('*Standup* Acme');
    expect(en).toContain('Decisions awaiting approval');
    expect(en).toContain('Pick vendor');
    const ja = renderOrganizationStandupText(standup, 'Acme', 'ja');
    expect(ja).toContain('*朝会* Acme');
    expect(ja).toContain('承認待ちの決定事項');
  });
});

describe('runOrganizationStandup', () => {
  it('requires the sovereign persona', () => {
    expect(() => runOrganizationStandup({ env: { KYBERION_PERSONA: 'worker' } }, deps())).toThrow(
      /requires KYBERION_PERSONA=sovereign/
    );
  });

  it('files and notifies per organization with activity, then audits', () => {
    const writeArtifact = vi
      .fn()
      .mockReturnValue({ repo_relative_path: 'active/x.json', artifact_id: 'ART-1' });
    const notify = vi.fn().mockReturnValue(true);
    const audit = vi.fn();
    const result = runOrganizationStandup(
      { env: { KYBERION_PERSONA: 'sovereign' }, locale: 'en' },
      {
        ...deps(),
        writeArtifact: writeArtifact as never,
        notify,
        audit,
        listOrganizations: (tier) => (tier === 'confidential' ? [scope] : []),
      }
    );
    expect(result.organization_count).toBe(1);
    expect(result.reported_count).toBe(1);
    expect(writeArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { organization: 'org-a', tenant: 'acme' },
        tier: 'confidential',
        artifact_class: 'report',
        name: expect.stringMatching(/^standups\/2026-10-05\.json$/),
      })
    );
    expect(notify).toHaveBeenCalledWith(
      'decision_digest',
      expect.objectContaining({ body: expect.stringContaining('Pick vendor') }),
      { route: { surface: 'inbox', target: 'organization-standup' } }
    );
    expect(result.standups[0].persistence).toMatchObject({ path: 'active/x.json', notified: true });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'organization.standup' }));
  });
});

describe('defaultStandupWindowHours', () => {
  it('reaches back to the previous weekday standup', () => {
    // 2026-10-05 is a Monday in Asia/Tokyo (09:00 local).
    expect(defaultStandupWindowHours(NOW, 'Asia/Tokyo')).toBe(72);
    expect(defaultStandupWindowHours(new Date('2026-10-06T00:00:00.000Z'), 'Asia/Tokyo')).toBe(24);
    expect(defaultStandupWindowHours(new Date('2026-10-04T00:00:00.000Z'), 'Asia/Tokyo')).toBe(48);
    // Still Sunday evening in UTC.
    expect(defaultStandupWindowHours(new Date('2026-10-04T23:00:00.000Z'), 'UTC')).toBe(48);
  });
});

describe('runOrganizationStandup scoped mode', () => {
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

  it('runs for the bound tenant without the sovereign persona and audits standup:scoped', () => {
    const audit = vi.fn();
    const other = { ...scope, organizationId: 'org-b' };
    const result = bound('acme', () =>
      runOrganizationStandup(
        { scope: cadenceScope, persist: false, locale: 'en', env: { KYBERION_PERSONA: 'worker' } },
        { ...deps(), audit, listOrganizations: () => [scope, other] }
      )
    );
    expect(result.organization_count).toBe(1);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'standup:scoped',
        tenantSlug: 'acme',
        agentId: 'organization_operator',
      })
    );
  });

  it('refuses a mismatched bound tenant', () => {
    expect(() =>
      bound('other', () =>
        runOrganizationStandup(
          { scope: cadenceScope, persist: false },
          { ...deps(), listOrganizations: () => [scope] }
        )
      )
    ).toThrow(/POLICY_VIOLATION/);
  });
});
