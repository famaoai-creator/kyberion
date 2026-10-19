import { describe, expect, it, vi } from 'vitest';

const principal = vi.hoisted(() => ({ owner: 'user:owner' as string | null }));
vi.mock('@agent/core/governance/cli-operator-principal', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent/core/governance/cli-operator-principal')>();
  return {
    ...actual,
    resolveCliOperatorIdentity: () => ({ principalId: principal.owner, displayName: 'Owner' }),
  };
});
import {
  grantDraftFromArgs,
  parseGrantsArgs,
  renderGrantCheck,
  renderGrantList,
  resolveRevoker,
  runGrantsCommand,
  type GrantsDeps,
} from './cli-grants.js';
import type { GrantRecord } from '@agent/core/governance/grant-store';

const NOW = new Date('2026-10-19T00:00:00.000Z');

const record: GrantRecord = {
  schema_version: 'grant-record.v1',
  grant_id: 'GRT-20261019-aaaaaaaaaaaa',
  capability: 'meeting.recording',
  scope: {
    tenant_slug: 'acme',
    meeting_series_ids: ['weekly'],
    meeting_urls: ['https://meet.google.com/abc-defg-hij'],
  },
  purpose: 'minutes',
  granted_by: { actor_id: 'user:owner', role: 'sovereign', assurance: 'A1' },
  basis: { approval_request_id: 'req-1', approval_channel: 'grant-standing' },
  granted_at: '2026-10-18T00:00:00.000Z',
  expires_at: '2026-11-17T00:00:00.000Z',
  audit_event_id: 'audit-1',
};

function deps(overrides: Partial<GrantsDeps> = {}): GrantsDeps {
  return {
    list: vi.fn(() => [record]),
    resolve: vi.fn(() => ({
      allowed: true,
      source: 'standing' as const,
      grant_id: record.grant_id,
    })),
    requestApproval: vi.fn(
      () => ({ id: 'req-9', status: 'pending', details: 'Capability: meeting.recording' }) as never
    ),
    grantWithApproval: vi.fn(() => record),
    grantDirect: vi.fn(() => record),
    revoke: vi.fn(() => ({
      ...record,
      revoked: { at: NOW.toISOString(), by: 'user:owner', reason: 'done', audit_event_id: 'a2' },
    })),
    find: vi.fn(() => record),
    revoker: () => ({ kind: 'human' as const, id: 'user:owner' }),
    now: () => NOW,
    ...overrides,
  };
}

async function run(argv: string[], d = deps()) {
  const out: string[] = [];
  await runGrantsCommand(argv, (text) => out.push(text), d);
  return { out: out.join('\n'), d };
}

describe('cli grants parsing', () => {
  it('collects repeatable meeting flags and rejects unknown options', () => {
    const parsed = parseGrantsArgs([
      'grant',
      '--capability',
      'meeting.recording',
      '--tenant',
      'acme',
      '--meeting-url',
      'https://a.example/x',
      '--meeting-url',
      'https://a.example/y',
      '--meeting-series',
      's1',
      '--purpose',
      'minutes',
      '--days',
      '30',
      '--request-approval',
    ]);
    expect(grantDraftFromArgs(parsed)).toEqual({
      capability: 'meeting.recording',
      tenant_slug: 'acme',
      meeting_urls: ['https://a.example/x', 'https://a.example/y'],
      meeting_series_ids: ['s1'],
      purpose: 'minutes',
      ttl_days: 30,
    });
    expect(parsed.flags.has('--request-approval')).toBe(true);
    expect(() => parseGrantsArgs(['list', '--purpose', 'x'])).toThrow(/Unknown option/);
    expect(() => parseGrantsArgs(['nope'])).toThrow(/Unknown grants command/);
    expect(() => parseGrantsArgs(['check', '--capability'])).toThrow(/requires a value/);
  });

  it('rejects a non-integer --days and missing required flags', () => {
    expect(() =>
      grantDraftFromArgs(
        parseGrantsArgs([
          'grant',
          '--capability',
          'c',
          '--tenant',
          't',
          '--purpose',
          'p',
          '--days',
          '1.5',
        ])
      )
    ).toThrow(/--days/);
    expect(() =>
      grantDraftFromArgs(parseGrantsArgs(['grant', '--capability', 'c', '--purpose', 'p']))
    ).toThrow(/--tenant/);
  });
});

describe('cli grants rendering', () => {
  it('list renders a Markdown table with status', () => {
    const out = renderGrantList([record], NOW, false);
    expect(out).toContain('| GRT-20261019-aaaaaaaaaaaa | meeting.recording | acme |');
    expect(out).toContain('| active |');
    expect(JSON.parse(renderGrantList([record], NOW, true))[0].status).toBe('active');
    expect(renderGrantList([], NOW, false)).toContain('no standing grants');
  });

  it('check shows the reason and the remedy', () => {
    const out = renderGrantCheck(
      'meeting.recording',
      { allowed: false, reason: 'no grant', remedy: 'pnpm kyberion grants grant ...' },
      false
    );
    expect(out).toContain('- allowed: no');
    expect(out).toContain('> [grants] no grant');
    expect(out).toContain('to allow it: pnpm kyberion grants grant');
  });
});

describe('cli grants commands', () => {
  it('check passes tenant, mission and meeting to the resolver', async () => {
    const { out, d } = await run([
      'check',
      '--capability',
      'meeting.recording',
      '--tenant',
      'acme',
      '--mission',
      'MSN-X',
      '--meeting-url',
      'https://meet.google.com/abc-defg-hij',
    ]);
    expect(d.resolve).toHaveBeenCalledWith({
      capability: 'meeting.recording',
      context: {
        tenant_slug: 'acme',
        mission_id: 'MSN-X',
        meeting: { url: 'https://meet.google.com/abc-defg-hij' },
        now: NOW,
      },
    });
    expect(out).toContain('- source: standing');
  });

  const grantArgs = [
    'grant',
    '--capability',
    'meeting.recording',
    '--tenant',
    'acme',
    '--meeting-url',
    'https://meet.google.com/abc-defg-hij',
    '--purpose',
    'minutes',
  ];

  it('grant --request-approval files an approval request and prints the next step', async () => {
    const { out, d } = await run([...grantArgs, '--request-approval']);
    expect(d.requestApproval).toHaveBeenCalled();
    expect(d.grantWithApproval).not.toHaveBeenCalled();
    expect(out).toContain('pnpm kyberion approvals --approve req-9');
    expect(out).toContain('--approval-request-id req-9');
  });

  it('grant --approval-request-id applies the approved grant', async () => {
    const { out, d } = await run([...grantArgs, '--approval-request-id', 'req-9']);
    expect(d.grantWithApproval).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_slug: 'acme' }),
      {
        approvalRequestId: 'req-9',
      }
    );
    expect(out).toContain('# Grant created');
  });

  it('an external_io grant without an approval flag is refused, never granted directly', async () => {
    const d = deps();
    await expect(run(grantArgs, d)).rejects.toThrow(/needs a human approval/);
    expect(d.grantDirect).not.toHaveBeenCalled();
    await expect(
      run([...grantArgs, '--request-approval', '--approval-request-id', 'r'], d)
    ).rejects.toThrow(/either/);
  });

  it('revoke records the resolved operator, never a free-text actor', async () => {
    const { out, d } = await run(['revoke', record.grant_id, '--reason', 'done']);
    expect(d.revoke).toHaveBeenCalledWith(record.grant_id, {
      by: { kind: 'human', id: 'user:owner' },
      reason: 'done',
    });
    expect(out).toContain('# Grant revoked');
    await expect(run(['revoke', record.grant_id])).rejects.toThrow(/--reason/);
    await expect(
      run(['revoke', record.grant_id, '--reason', 'x'], deps({ find: vi.fn(() => null) }))
    ).rejects.toThrow(/not found/);
  });

  it('library errors surface as script exit errors', async () => {
    const d = deps({
      grantWithApproval: vi.fn(() => {
        throw new Error('[approval_invalid] grant approval is pending, not approved');
      }),
    });
    await expect(run([...grantArgs, '--approval-request-id', 'r'], d)).rejects.toThrow(
      /pending, not approved/
    );
  });
});

describe('resolveRevoker', () => {
  it('attributes an agent session to the agent even when an owner member exists', () => {
    principal.owner = 'user:owner';
    expect(resolveRevoker({ KYBERION_AGENT_ID: 'grants-tester' })).toEqual({
      kind: 'agent',
      id: 'agent:grants-tester',
    });
  });

  it('a plain terminal revokes as the owner member, and fails without one', () => {
    principal.owner = 'user:owner';
    expect(resolveRevoker({})).toEqual({ kind: 'human', id: 'user:owner' });
    principal.owner = null;
    expect(() => resolveRevoker({})).toThrow(/No operator identity/);
    principal.owner = 'user:owner';
  });
});
