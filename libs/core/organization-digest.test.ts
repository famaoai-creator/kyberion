import { describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';

const auditRecords = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('./audit-chain.js', () => ({
  auditChain: { record: (entry: Record<string, unknown>) => auditRecords.push(entry) },
}));

import {
  organizationOperationalStatePath,
  saveOrganizationOperationalState,
} from './organization-operating-model-persistence.js';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeReadFile, safeRmSync, safeSymlinkSync } from './secure-io.js';
import {
  buildOrganizationDigest,
  businessDaysBetween,
  renderOrganizationDigestText,
  runOrganizationDigest,
  type OrganizationDigestSource,
} from './organization-digest.js';
import type {
  OrganizationDecisionRecord,
  OrganizationIncidentRecord,
  OrganizationOperationRecord,
  OrganizationServiceRecord,
  OrganizationServiceState,
} from './organization-operating-model.js';

// 2026-09-25 (Thu) 08:30 JST
const NOW = new Date('2026-09-24T23:30:00.000Z');
const scope = { organization_id: 'org-a', tier: 'confidential' as const, tenant_slug: 'tenant-a' };

function operation(
  id: string,
  overrides: Partial<OrganizationOperationRecord> = {}
): OrganizationOperationRecord {
  return {
    ...scope,
    version: '1.0.0',
    operation_id: id,
    name: `op ${id}`,
    operation_type: 'scheduled',
    owner_role: 'owner',
    trigger: { kind: 'schedule', expression: '0 9 * * 1-5', timezone: 'Asia/Tokyo' },
    automation_boundary: {
      allowed_actions: [],
      approval_required_actions: [],
      forbidden_actions: [],
    },
    escalation_path: [],
    evidence_outputs: [],
    execution_target: { kind: 'runbook', ref: 'knowledge/x.md' },
    status: 'active',
    updated_at: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

function service(id: string, status: OrganizationServiceRecord['status'] = 'active') {
  return { ...scope, service_id: id, name: `svc ${id}`, status } as OrganizationServiceRecord;
}

function serviceState(id: string, sourceTimestamp: string, freshnessDays: number) {
  return {
    ...scope,
    service_id: id,
    health: 'healthy',
    observed_at: sourceTimestamp,
    source_timestamp: sourceTimestamp,
    freshness_seconds: freshnessDays * 86_400,
    confidence: 1,
    reconcile_status: 'current',
    updated_at: sourceTimestamp,
  } as OrganizationServiceState;
}

function decision(id: string, status: OrganizationDecisionRecord['status'], dueAt: string) {
  return {
    ...scope,
    decision_id: id,
    title: `決定 ${id}`,
    status,
    due_at: dueAt,
  } as OrganizationDecisionRecord;
}

function source(overrides: Partial<OrganizationDigestSource> = {}): OrganizationDigestSource {
  return {
    state: { ...scope, name: '組織A', status: 'active', updated_at: '2026-09-01T00:00:00.000Z' },
    operations: [],
    operationStates: [],
    services: [],
    serviceStates: [],
    decisions: [],
    incidents: [],
    ...overrides,
  };
}

function lastRun(operationId: string, at: string, status: 'succeeded' | 'failed' = 'succeeded') {
  return {
    ...scope,
    operation_id: operationId,
    status,
    due_status: 'current' as const,
    last_run_at: at,
    updated_at: at,
  };
}

describe('organization digest', () => {
  it('counts business days on the Japanese bank calendar', () => {
    // Sep 19-23, 2026: weekend + 敬老の日 + 国民の休日 + 秋分の日.
    expect(
      businessDaysBetween({ year: 2026, month: 9, day: 18 }, { year: 2026, month: 9, day: 24 })
    ).toBe(1);
    expect(
      businessDaysBetween({ year: 2026, month: 9, day: 25 }, { year: 2026, month: 9, day: 25 })
    ).toBe(0);
  });

  it('flags overdue, failed, and due-today operations and missed deadlines', () => {
    const digest = buildOrganizationDigest(
      [
        source({
          operations: [
            operation('overdue'),
            operation('today'),
            operation('failed'),
            operation('monthly', {
              trigger: { kind: 'schedule', expression: '0 9 1 * *', timezone: 'Asia/Tokyo' },
              deadline: { kind: 'business_day_of_month', business_day: 5, time: '17:00' },
            }),
            operation('paused', { status: 'paused' }),
          ],
          operationStates: [
            lastRun('overdue', '2026-09-23T00:30:00.000Z'),
            lastRun('today', '2026-09-24T01:00:00.000Z'),
            lastRun('failed', '2026-09-24T01:00:00.000Z', 'failed'),
            lastRun('monthly', '2026-08-31T08:00:00.000Z'),
          ],
        }),
      ],
      { now: NOW }
    );
    const [entry] = digest.organizations;
    expect(
      Object.fromEntries(entry.due_operations.map((item) => [item.operation_id, item.kind]))
    ).toEqual({ overdue: 'overdue', today: 'due_today', failed: 'failed' });
    expect(entry.deadlines).toEqual([
      expect.objectContaining({ operation_id: 'monthly', status: 'missed' }),
    ]);
    const text = renderOrganizationDigestText(digest);
    expect(text).toContain('*期限切れ・本日期限の運用*');
    expect(text).toContain('[期限切れ] op overdue — 予定 9/24(木) 09:00');
    expect(text).toContain('[本日期限] op today — 予定 9/25(金) 09:00');
    expect(text).toContain('[期限超過] op monthly — 期限 9/7(月) 17:00');
  });

  it('falls back to cron due reporting when an operation has no deadline projection', () => {
    // A deadline without a trigger timezone cannot be projected; the cron slot
    // must still surface instead of being suppressed as "judged by deadline".
    const digest = buildOrganizationDigest(
      [
        source({
          operations: [
            operation('legacy', {
              trigger: { kind: 'schedule', expression: '0 9 * * 1-5' },
              deadline: { kind: 'business_day_of_month', business_day: 23, time: '17:00' },
            }),
          ],
          operationStates: [lastRun('legacy', '2026-09-01T01:00:00.000Z')],
        }),
      ],
      { now: NOW }
    );
    expect(digest.organizations[0].due_operations).toEqual([
      expect.objectContaining({ operation_id: 'legacy', kind: 'overdue' }),
    ]);
  });

  it('judges a deadline from the run list, keeping a late completion missed', () => {
    const monthly = operation('monthly', {
      trigger: { kind: 'schedule', expression: '0 9 1 * *', timezone: 'Asia/Tokyo' },
      deadline: { kind: 'business_day_of_month', business_day: 5, time: '17:00' },
    });
    const runAt = (completedAt: string) => ({
      ...scope,
      run_id: `monthly-${completedAt.slice(0, 10)}`,
      operation_id: 'monthly',
      status: 'succeeded' as const,
      started_at: completedAt,
      completed_at: completedAt,
      recorded_at: completedAt,
    });
    // Sep 2026: 5th business day is Mon Sep 7 17:00 JST; completed Sep 8.
    const late = buildOrganizationDigest(
      [
        source({
          operations: [monthly],
          operationStates: [lastRun('monthly', '2026-09-08T01:00:00.000Z')],
          runs: [runAt('2026-09-08T01:00:00.000Z')],
        }),
      ],
      { now: NOW }
    );
    expect(late.organizations[0].deadlines).toEqual([
      expect.objectContaining({ operation_id: 'monthly', status: 'missed', completed_late: true }),
    ]);
    const onTime = buildOrganizationDigest(
      [source({ operations: [monthly], runs: [runAt('2026-09-04T01:00:00.000Z')] })],
      { now: NOW }
    );
    expect(onTime.organizations[0].deadlines).toEqual([]);
  });

  it('shows upcoming deadlines only within two business days', () => {
    const monthly = operation('monthly', {
      trigger: { kind: 'schedule', expression: '0 9 1 * *', timezone: 'Asia/Tokyo' },
      deadline: { kind: 'business_day_of_month', business_day: 5, time: '17:00' },
    });
    const input = [source({ operations: [monthly] })];
    // Oct 2026: 5th business day is Wed Oct 7.
    const soon = buildOrganizationDigest(input, { now: new Date('2026-10-05T23:30:00.000Z') });
    expect(soon.organizations[0].deadlines).toEqual([
      expect.objectContaining({ status: 'upcoming', business_days_remaining: 1 }),
    ]);
    expect(renderOrganizationDigestText(soon)).toContain(
      'op monthly — あと1営業日（10/7(水) 17:00）'
    );
    const early = buildOrganizationDigest(input, { now: new Date('2026-09-30T23:30:00.000Z') });
    expect(early.organizations[0].deadlines).toEqual([]);
  });

  it('caps pending decisions per organization and reports service observation windows', () => {
    const digest = buildOrganizationDigest(
      [
        source({
          decisions: [
            ...Array.from({ length: 7 }, (_, index) =>
              decision(
                `d${index + 1}`,
                index % 2 ? 'proposed' : 'pending_approval',
                `2026-10-0${index + 1}T00:00:00.000Z`
              )
            ),
            decision('done', 'approved', '2026-09-01T00:00:00.000Z'),
          ],
          services: [
            service('expiring'),
            service('stale'),
            service('unobserved'),
            service('fresh'),
            service('retired', 'retired'),
          ],
          serviceStates: [
            serviceState('expiring', '2026-09-01T00:00:00.000Z', 27),
            serviceState('stale', '2026-08-01T00:00:00.000Z', 30),
            serviceState('fresh', '2026-09-20T00:00:00.000Z', 30),
          ],
          incidents: [
            { ...scope, incident_id: 'i1', title: '障害1', severity: 'high', status: 'mitigating' },
            { ...scope, incident_id: 'i2', title: '障害2', severity: 'low', status: 'resolved' },
          ] as OrganizationIncidentRecord[],
        }),
      ],
      { now: NOW }
    );
    const [entry] = digest.organizations;
    expect(entry.pending_decisions).toHaveLength(7);
    expect(entry.expiring_services.map((item) => item.service_id)).toEqual(['expiring']);
    expect(entry.stale_services.map((item) => item.service_id)).toEqual(['stale']);
    expect(entry.unobserved_services.map((item) => item.service_id)).toEqual(['unobserved']);
    expect(entry.open_incidents.map((item) => item.incident_id)).toEqual(['i1']);
    const text = renderOrganizationDigestText(digest);
    expect(text).toContain('_組織A_ 7件\n• 決定 d1');
    expect(text).toContain('• 決定 d5');
    expect(text).not.toContain('• 決定 d6');
    expect(text).toContain('• ほか2件');
    expect(text).toContain('[7日以内に失効] svc expiring — 9/28(月)まで');
    expect(text).toContain('[失効] svc stale（8/31(月)失効）');
    expect(text).toContain('[未観測] svc unobserved');
    expect(text).toContain('[high] 障害1（mitigating）');
    expect(text).not.toContain('svc fresh');
    expect(text).not.toContain('営業日期限');
  });

  it('truncates long decision titles for a phone-readable DM', () => {
    const long = {
      ...decision('long', 'proposed', '2026-10-01T00:00:00.000Z'),
      title: 'あ'.repeat(45),
    };
    const text = renderOrganizationDigestText(
      buildOrganizationDigest([source({ decisions: [long] })], { now: NOW })
    );
    expect(text).toContain(`• ${'あ'.repeat(40)}…（期限 10/1(木)）`);
  });

  it('groups by organization display name and renders one line when clean', () => {
    const clean = buildOrganizationDigest(
      [
        source(),
        source({
          state: {
            ...scope,
            organization_id: 'org-b',
            name: '組織B',
            status: 'archived',
            updated_at: '',
          },
          services: [service('unobserved')],
        }),
      ],
      { now: NOW }
    );
    expect(clean.status).toBe('clean');
    expect(clean.organization_count).toBe(1);
    expect(clean.tenants).toEqual(['tenant-a']);
    expect(renderOrganizationDigestText(clean)).toBe(
      '*組織運営ダイジェスト* 9/25(金) 08:30（1組織）\n対応が必要な項目はありません。'
    );
  });

  it('renders through the vocabulary catalog in other locales', () => {
    const digest = buildOrganizationDigest(
      [source({ decisions: [decision('d1', 'proposed', '2026-10-01T00:00:00.000Z')] })],
      { now: NOW }
    );
    expect(renderOrganizationDigestText(digest, 'en')).toBe(
      [
        '*Organization digest* 9/25(Fri) 08:30 (1 organizations)',
        '',
        '*Decisions awaiting approval*',
        '_組織A_ 1 pending',
        '• 決定 d1 (due 10/1(Thu))',
      ].join('\n')
    );
  });

  it('skips an unreadable tenant instead of failing the whole digest', () => {
    const unique = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const rootDir = pathResolver.sharedTmp(`organization-digest-skip-${unique}`);
    const outsideDir = pathResolver.sharedTmp(`organization-digest-skip-target-${unique}`);
    auditRecords.length = 0;
    try {
      saveOrganizationOperationalState(
        {
          organization_id: 'org-good',
          name: '組織良',
          tier: 'public',
          tenant_slug: 'tenant-good',
          status: 'active',
          updated_at: '2026-09-01T00:00:00.000Z',
        },
        { rootDir }
      );
      saveOrganizationOperationalState(
        {
          organization_id: 'org-bad',
          name: '組織悪',
          tier: 'public',
          tenant_slug: 'tenant-bad',
          status: 'active',
          updated_at: '2026-09-01T00:00:00.000Z',
        },
        { rootDir }
      );
      // A symlinked record directory makes discovery fail closed for that tenant.
      const operationsDir = path.join(
        path.dirname(organizationOperationalStatePath('org-bad', 'public', 'tenant-bad', rootDir)),
        'operations'
      );
      safeMkdir(operationsDir, { recursive: true });
      safeMkdir(outsideDir, { recursive: true });
      safeSymlinkSync(outsideDir, path.join(operationsDir, 'linked'), 'dir');

      const run = runOrganizationDigest({
        env: { KYBERION_PERSONA: 'sovereign' },
        rootDir,
        tiers: ['public'],
        now: NOW,
      });
      expect(run.digest.organization_count).toBe(1);
      expect(run.digest.skipped_tenants).toEqual([{ tier: 'public', tenant_slug: 'tenant-bad' }]);
      expect(run.digest.status).toBe('attention');
      expect(run.text).toContain('読み込めなかったテナント（集計から除外）: public/tenant-bad');
      expect(auditRecords[0]?.metadata).toMatchObject({
        skipped_tenants: ['public/tenant-bad'],
      });
    } finally {
      safeRmSync(rootDir, { recursive: true, force: true });
      safeRmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('keeps the cross-tenant digest out of the shared run journal', () => {
    const pipeline = JSON.parse(
      safeReadFile(pathResolver.rootResolve('pipelines/organization-daily-digest.json'), {
        encoding: 'utf8',
      }) as string
    );
    const step = pipeline.steps.find((entry: { id: string }) => entry.id === 'build_digest');
    expect(step.produces).toMatchObject({ channel: 'organization_digest', sensitive: true });
    // Chronos delivery still reads the live context, not the journal.
    expect(pipeline.schedule.deliver_to.template).toBe('{{context.organization_digest.text}}');
  });

  it('refuses cross-tenant aggregation without the sovereign persona', () => {
    expect(() =>
      runOrganizationDigest({ env: { KYBERION_PERSONA: 'ecosystem_architect' } })
    ).toThrow(/requires KYBERION_PERSONA=sovereign/);
    expect(() => runOrganizationDigest({ env: {} })).toThrow(/got unset/);
  });
});
