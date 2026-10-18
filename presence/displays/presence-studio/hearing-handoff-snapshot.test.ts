import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveMemberByPrincipal } from '@agent/core/organization/member-registry';
import { readHearingCompletion } from './hearing-completion.js';
import {
  hearingHandoffSnapshot,
  assertHearingHandoffSnapshot,
  withHearingHandoffSnapshot,
} from './hearing-handoff-snapshot.js';
import type { HearingRecord } from './hearing.js';
import type { PresenceStudioViewerContext } from './security.js';

vi.mock('@agent/core/organization/member-registry', async () => ({
  ...(await vi.importActual<typeof import('@agent/core/organization/member-registry')>(
    '@agent/core/organization/member-registry'
  )),
  resolveMemberByPrincipal: vi.fn(),
}));
vi.mock('./hearing-completion.js', async () => ({
  ...(await vi.importActual<typeof import('./hearing-completion.js')>('./hearing-completion.js')),
  readHearingCompletion: vi.fn(),
}));
const record: HearingRecord = {
  session_id: 'displayed-view',
  scenario: 'work_inventory',
  requirements: [
    {
      id: 'task_name',
      label_key: 'front_desk:hearing_inventory_task_name',
      answer: 'Private answer',
      confidence: 1,
    },
  ],
  canvas_versions: [],
  updated_at: '2026-10-18T00:00:00Z',
  record_revision: 4,
  requirements_revision: 2,
  decision_revision: 3,
  current_decision_operation_id: 'decision-original',
  decided_at: '2026-10-18T00:00:00Z',
  decided_by: {
    kind: 'human',
    id: 'user:decider',
    role: 'owner',
    display_name: 'Original decider',
  },
};
const viewer: PresenceStudioViewerContext = {
  principalId: 'current-principal',
  source: 'loopback',
  tenantSlugs: ['snapshot-alpha'],
  organizationIds: ['org-one', 'org-two'],
  projectIds: ['project-one', 'project-two'],
};
const member = {
  member_id: 'current-member',
  display_name: 'Current member',
  status: 'active' as const,
  memberships: [],
  access_registrations: [],
  created_at: record.updated_at,
  updated_at: record.updated_at,
};
beforeEach(() => {
  vi.mocked(resolveMemberByPrincipal).mockReset().mockReturnValue(member);
  vi.mocked(readHearingCompletion).mockReset().mockReturnValue(undefined);
});
const body = () => ({ handoff_snapshot: hearingHandoffSnapshot(record, viewer)! });
describe('displayed hearing handoff snapshot contract', () => {
  it('issues a minimal versioned validator without private answers or identities', () => {
    const snapshot = body();
    expect(snapshot).toEqual({
      handoff_snapshot: { version: 1, token: expect.stringMatching(/^[a-f0-9]{64}$/u) },
    });
    expect(JSON.stringify(snapshot)).not.toContain('Private answer');
    expect(JSON.stringify(snapshot)).not.toContain(member.member_id);
    expect(() => assertHearingHandoffSnapshot(snapshot, record, viewer)).not.toThrow();
  });
  it.each([
    ['session', { session_id: 'another-session' }],
    ['scenario', { scenario: 'web_app_build' }],
    ['requirements revision', { requirements_revision: 3 }],
    ['answer', { requirements: [{ ...record.requirements[0], answer: 'Newer answer' }] }],
    ['decision revision', { decision_revision: 4 }],
    ['decision operation', { current_decision_operation_id: 'decision-newer' }],
    ['decision time', { decided_at: '2026-10-18T01:00:00Z' }],
    ['decider', { decided_by: { ...record.decided_by!, id: 'user:newer' } }],
  ] satisfies Array<[string, Partial<HearingRecord>]>)('rejects changed %s', (_name, patch) => {
    expect(() => assertHearingHandoffSnapshot(body(), { ...record, ...patch }, viewer)).toThrow(
      'stale_snapshot'
    );
  });
  it.each([
    ['principal', { principalId: 'another-principal' }],
    ['source and tier', { source: 'token' }],
    ['tenant', { tenantSlugs: ['snapshot-bravo'] }],
    ['organization', { organizationIds: ['org-other'] }],
    ['project', { projectIds: ['project-other'] }],
  ] satisfies Array<[string, Partial<PresenceStudioViewerContext>]>)(
    'rejects changed viewer %s',
    (_name, patch) => {
      expect(() => assertHearingHandoffSnapshot(body(), record, { ...viewer, ...patch })).toThrow(
        'stale_snapshot'
      );
    }
  );
  it('rejects a changed member mapping for the same authenticated principal', () => {
    const snapshot = body();
    vi.mocked(resolveMemberByPrincipal).mockReturnValue({ ...member, member_id: 'new-member' });
    expect(() => assertHearingHandoffSnapshot(snapshot, record, viewer)).toThrow('stale_snapshot');
  });
  it('canonicalizes equivalent scope sets and ignores canvas-only metadata', () => {
    expect(() =>
      assertHearingHandoffSnapshot(
        body(),
        {
          ...record,
          record_revision: 9,
          canvas_versions: ['v1'],
          canvas_generation: 'generated',
          updated_at: '2026-10-18T01:00:00Z',
        },
        {
          ...viewer,
          organizationIds: ['org-two', 'org-one', 'org-one'],
          projectIds: ['project-two', 'project-one'],
        }
      )
    ).not.toThrow();
  });
  it('treats pre-upgrade missing decision revision as zero without modifying the record', () => {
    const legacy = { ...record };
    delete legacy.decision_revision;
    const before = JSON.stringify(legacy);
    const snapshot = hearingHandoffSnapshot(legacy, viewer)!;
    expect(snapshot).toEqual(hearingHandoffSnapshot({ ...legacy, decision_revision: 0 }, viewer));
    expect(() =>
      assertHearingHandoffSnapshot(
        { handoff_snapshot: snapshot },
        { ...legacy, decision_revision: 4 },
        viewer
      )
    ).toThrow('stale_snapshot');
    expect(JSON.stringify(legacy)).toBe(before);
  });
  it('allows a later registered caller while preserving the original decider', () => {
    const projected = withHearingHandoffSnapshot(record, viewer);
    expect(projected.decided_by).toEqual(record.decided_by);
    expect(projected.handoff_snapshot).toBeDefined();
    expect(member.member_id).not.toBe(record.decided_by!.id.slice(5));
  });
  it.each([
    null,
    [],
    {},
    { version: 1 },
    { handoff_snapshot: null },
    { handoff_snapshot: { version: 2, token: 'a'.repeat(64) } },
    { handoff_snapshot: { version: 1, token: 'invalid' } },
    { handoff_snapshot: { version: 1, token: 'a'.repeat(64), actor: 'spoof' } },
    { handoff_snapshot: { version: 1, token: 'a'.repeat(64) }, tenant: 'spoof' },
  ])('rejects malformed or missing proof %j', (invalid) => {
    expect(() => assertHearingHandoffSnapshot(invalid, record, viewer)).toThrow(/snapshot/u);
  });
  it.each(['unregistered', 'unavailable', 'undecided', 'pending'] as const)(
    'omits %s proof while keeping the ordinary view readable',
    (mode) => {
      const input = { ...record };
      if (mode === 'unregistered') vi.mocked(resolveMemberByPrincipal).mockReturnValue(null);
      if (mode === 'unavailable')
        vi.mocked(readHearingCompletion).mockReturnValue({
          kind: 'inventory',
          status: 'unavailable',
        });
      if (mode === 'undecided') delete input.decided_at;
      if (mode === 'pending')
        input.handoff_pending = {
          kind: 'inventory',
          token: 'private-pending',
          requirements_revision: 2,
          started_at: record.updated_at,
        };
      const projected = withHearingHandoffSnapshot(
        { ...input, handoff_snapshot: { version: 1, token: 'forged' } } as HearingRecord,
        viewer
      );
      expect(projected).not.toHaveProperty('handoff_snapshot');
      expect(projected).not.toHaveProperty('handoff_pending');
      expect(projected.requirements).toEqual(record.requirements);
    }
  );
  it('preserves a current snapshot across verified completed-result replay', () => {
    const snapshot = body();
    vi.mocked(readHearingCompletion).mockReturnValue({
      kind: 'inventory',
      status: 'ready',
      id: 'entry-one',
      next: { href: '/progress' },
    });
    expect(() =>
      assertHearingHandoffSnapshot(snapshot, { ...record, record_revision: 6 }, viewer)
    ).not.toThrow();
  });
});
