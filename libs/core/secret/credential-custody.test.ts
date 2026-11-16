import { describe, expect, it, vi } from 'vitest';
import {
  assessCredentialEligibility,
  buildCredentialRecord,
  credentialConnectionPath,
  credentialLendingErrors,
  credentialRecordPath,
  credentialValueFingerprint,
  isCredentialLendingRefusal,
  legacyCredentialLending,
  lendingFromRecord,
  lendingMatchesRecord,
  parseCredentialRef,
  subscriptionTokenDaysLeft,
  type CredentialEligibilityDeps,
} from './credential-custody.js';
import {
  assessCredentialBudget,
  monthOf,
  summarizeCredentialUsage,
} from './credential-usage-ledger.js';
import { calendarDateInZone, zonedWallTimeToInstant } from '../temporal/business-calendar.js';
import { installationTimezone } from '../temporal/temporal-context.js';
import { providerAuthHomeRelativePath } from '../provider/provider-auth-home.js';
import {
  resetCredentialBudgetAlerts,
  runCredentialUsageMonthly,
} from './credential-usage-report.js';
import type { GrantRecord } from '../governance/grant-store.js';

const NOW = new Date('2026-11-16T00:00:00Z');
const VALUE = 'sk-ant-test-value-0001';
const record = (
  credentialRef: string,
  extra: Partial<Parameters<typeof buildCredentialRecord>[0]> = {}
) =>
  buildCredentialRecord({
    credentialRef,
    value: VALUE,
    registeredBy: 'user:owner',
    now: NOW,
    ...extra,
  });
const lend = (
  credentialRef: string,
  extra: Partial<Parameters<typeof buildCredentialRecord>[0]> = {}
) => lendingFromRecord(record(credentialRef, extra));
function deps(
  personalOwners: Record<string, string>,
  attested = true,
  person = 'owner'
): CredentialEligibilityDeps {
  return {
    personalOwnerOf: (tenant) => personalOwners[tenant],
    installationPerson: () => person,
    borrowerAttested: () => attested,
  };
}
const code = (result: ReturnType<typeof assessCredentialEligibility>) =>
  'code' in result ? result.code : 'ok';

describe('credential_ref and registered record', () => {
  it('parses, formats and places custody refs and records', () => {
    expect(parseCredentialRef('tenant:parent:anthropic:kyberion-sub')).toEqual({
      custody: 'tenant',
      owner: 'parent',
      service: 'anthropic',
      label: 'kyberion-sub',
    });
    const ref = parseCredentialRef('tenant:parent:anthropic:kyberion-sub');
    expect(credentialConnectionPath(ref)).toBe(
      'knowledge/confidential/parent/connections/anthropic.kyberion-sub.json'
    );
    expect(credentialRecordPath(ref)).toBe(
      'knowledge/confidential/parent/connections/anthropic.kyberion-sub.record.json'
    );
    expect(credentialConnectionPath(parseCredentialRef('person:owner:claude-subscription'))).toBe(
      'knowledge/personal/connections/claude-subscription.json'
    );
    for (const bad of [
      'system:x:anthropic',
      'tenant:parent:mistral',
      'person:owner',
      'tenant:Bad:anthropic',
    ])
      expect(() => parseCredentialRef(bad)).toThrow(/CREDENTIAL_(?:REF_INVALID|SERVICE_UNKNOWN)/);
  });

  it('derives kind/terms/plan/expiry and the value fingerprint at registration', () => {
    const key = record('tenant:parent:anthropic');
    expect(key).toMatchObject({ kind: 'api_key', terms: 'commercial', plan: 'api' });
    expect(key.value_fingerprint).toBe(credentialValueFingerprint(VALUE));
    expect(key.value_fingerprint).not.toContain(VALUE);
    const pro = record('person:owner:claude-subscription', { plan: 'pro' });
    expect(pro).toMatchObject({ kind: 'subscription_token', terms: 'consumer' });
    // Default expiry = local midnight in the installation timezone + 365 days.
    const tz = installationTimezone();
    const expectedExpiry = new Date(
      zonedWallTimeToInstant(calendarDateInZone(NOW, tz), '00:00', tz).getTime() + 365 * 86_400_000
    ).toISOString();
    expect(pro.token_expires_at).toBe(expectedExpiry);
    expect(subscriptionTokenDaysLeft(pro, NOW)).toBe(
      Math.floor((Date.parse(expectedExpiry) - NOW.getTime()) / 86_400_000)
    );
    expect(record('person:owner:claude-subscription', { plan: 'team' }).terms).toBe('commercial');
    expect(() => record('person:owner:claude-subscription')).toThrow(/CREDENTIAL_PLAN_INVALID/);
    expect(() =>
      record('person:owner:claude-subscription', { plan: 'team', contractTenant: 'parent' })
    ).toThrow(/person-held credential has no contract tenant/);
    expect(record('tenant:parent:claude-subscription', { plan: 'team' }).contract_tenant).toBe(
      'parent'
    );
    expect(() => record('tenant:parent:anthropic', { contractTenant: 'child' })).toThrow(
      /contracted by its owner tenant/
    );
  });

  it('takes lending terms from the record; flags are only consistency checks', () => {
    const pro = record('person:owner:claude-subscription', { plan: 'pro' });
    const lending = lendingFromRecord(pro);
    expect(lending).toMatchObject({ plan: 'pro', allowed_backends: ['claude-cli'] });
    expect(lendingMatchesRecord(lending, pro)).toBe(true);
    expect(() => lendingFromRecord(pro, { expect: { plan: 'team' } })).toThrow(
      /CREDENTIAL_RECORD_MISMATCH.*plan pro/
    );
    expect(() => lendingFromRecord(pro, { backends: ['anthropic'] })).toThrow(
      /CREDENTIAL_BACKEND_INVALID/
    );
    // A record re-registered with another value no longer matches the approved grant.
    expect(
      lendingMatchesRecord(lending, {
        ...pro,
        value_fingerprint: credentialValueFingerprint('x'.repeat(12)),
      })
    ).toBe(false);
    expect(credentialLendingErrors(lending)).toEqual([]);
    expect(credentialLendingErrors({ ...lending, terms: 'commercial' })).toContain(
      'credential_lending.terms is not canonical'
    );
  });

  it('reads legacy grants as person custody API keys', () => {
    expect(
      legacyCredentialLending({
        scope: { credential_provider: 'anthropic', credential_ref: 'anthropic/API_KEY' },
        granted_by: { actor_id: 'user:owner' },
      })
    ).toMatchObject({
      credential_ref: 'person:owner:anthropic',
      custody: 'person',
      kind: 'api_key',
    });
  });

  it('places the isolated provider HOME on the borrower cache floor per credential', () => {
    const a = providerAuthHomeRelativePath(
      'confidential',
      'child',
      'claude',
      'tenant:parent:anthropic'
    );
    const b = providerAuthHomeRelativePath(
      'confidential',
      'child',
      'claude',
      'person:owner:anthropic'
    );
    expect(a).toMatch(
      /^active\/shared\/cache\/confidential\/child\/provider-auth\/claude\/[0-9a-f]{16}\/home$/
    );
    expect(a).not.toBe(b);
    expect(() =>
      providerAuthHomeRelativePath('public', 'child', 'claude', 'tenant:parent:anthropic')
    ).toThrow(/CREDENTIAL_HOME_INVALID/);
  });
});

describe('eligibility matrix (design §2.3, review B1/S1)', () => {
  const apiKey = lend('tenant:parent:anthropic');
  const personKey = lend('person:owner:anthropic');
  const pro = lend('person:owner:claude-subscription', { plan: 'pro' });
  const team = lend('person:owner:claude-subscription', { plan: 'team' });
  // Re-review 3: even a hand-built person lending carrying a contract tenant is not a path.
  const forgedContract = { ...team, contract_tenant: 'parent' };
  const tenantSeat = lend('tenant:parent:claude-subscription', { plan: 'enterprise' });
  // `home` is explicitly owner's personal tenant; `parent` / `child` are company tenants.
  const d = deps({ home: 'user:owner' });

  it.each([
    ['api_key → any attested tenant', apiKey, 'child', d, 'ok'],
    ['person api_key → any attested tenant', personKey, 'client', d, 'ok'],
    [
      'api_key → borrower without attestation',
      apiKey,
      'child',
      deps({}, false),
      'CREDENTIAL_ATTESTATION_REQUIRED',
    ],
    ['consumer token → explicit personal tenant', pro, 'home', d, 'ok'],
    ['consumer token → company tenant', pro, 'parent', d, 'CREDENTIAL_KIND_NOT_ELIGIBLE'],
    ['seat token → explicit personal tenant', team, 'home', d, 'ok'],
    [
      'person seat token → company named as contract tenant',
      forgedContract,
      'parent',
      d,
      'CREDENTIAL_KIND_NOT_ELIGIBLE',
    ],
    ['seat token → another tenant', team, 'child', d, 'CREDENTIAL_KIND_NOT_ELIGIBLE'],
    ['tenant seat token → owner tenant', tenantSeat, 'parent', d, 'ok'],
    [
      'tenant seat token → lent to another tenant',
      tenantSeat,
      'child',
      d,
      'CREDENTIAL_KIND_NOT_ELIGIBLE',
    ],
    [
      'person ref naming another member (confused deputy)',
      lend('person:alice:anthropic'),
      'child',
      d,
      'CREDENTIAL_CUSTODY_PERSON_MISMATCH',
    ],
  ])('%s', (_name, lending, borrower, lookups, expected) => {
    expect(code(assessCredentialEligibility(lending, borrower, NOW, lookups))).toBe(expected);
  });

  it('member-registry owner of every tenant does not make a company tenant personal', () => {
    // ensureOwnerMember gives `owner` an owner membership on every tenant; only personal_owner counts.
    expect(code(assessCredentialEligibility(pro, 'parent', NOW, deps({})))).toBe(
      'CREDENTIAL_KIND_NOT_ELIGIBLE'
    );
  });

  it('re-evaluates at use: clearing personal_owner after approval stops the token', () => {
    expect(code(assessCredentialEligibility(pro, 'home', NOW, d))).toBe('ok');
    expect(code(assessCredentialEligibility(pro, 'home', NOW, deps({})))).toBe(
      'CREDENTIAL_KIND_NOT_ELIGIBLE'
    );
  });

  it('stops an expired token with a renewal command', () => {
    const result = assessCredentialEligibility(pro, 'home', new Date('2027-12-01T00:00:00Z'), d);
    expect(code(result)).toBe('CREDENTIAL_TOKEN_EXPIRED');
    expect('message' in result && result.message).toMatch(/claude setup-token/);
    expect(isCredentialLendingRefusal(new Error('[CREDENTIAL_VALUE_CHANGED] x'))).toBe(true);
  });
});

describe('usage ledger and budget (design §6, review S4)', () => {
  const row = (ref: string, cost: number, at = '2026-11-10T00:00:00Z', tenant = 'child') => ({
    timestamp: at,
    credential_ref: ref,
    credential_kind: 'api_key',
    scope: { tenant_slug: tenant },
    agent: 'claude-cli',
    usage: { prompt_tokens: 100, completion_tokens: 20, cache_read_tokens: 5 },
    cost_usd: cost,
  });
  const lending = lendingFromRecord(record('tenant:parent:anthropic'), { budgetMonthlyUsd: 100 });

  it('uses installation-timezone calendar months', () => {
    // Zone pinned to Asia/Tokyo: the instant crosses the month boundary there.
    expect(monthOf(new Date('2026-11-30T15:30:00Z'), 'Asia/Tokyo')).toBe('2026-12');
    expect(monthOf(new Date('2026-11-30T14:59:00Z'), 'Asia/Tokyo')).toBe('2026-11');
    // The default follows the OS-reported installation timezone.
    const tz = installationTimezone();
    for (const at of ['2026-11-30T15:30:00Z', '2026-11-30T14:59:00Z']) {
      const { year, month } = calendarDateInZone(new Date(at), tz);
      expect(monthOf(new Date(at))).toBe(`${year}-${String(month).padStart(2, '0')}`);
    }
  });

  it('summarizes per borrower, credential and month, ignoring unstamped and other-month rows', () => {
    const history = () => [
      row('tenant:parent:anthropic', 30),
      row('tenant:parent:anthropic', 20),
      row('tenant:parent:anthropic', 99, '2026-10-31T14:00:00Z'),
      { timestamp: '2026-11-10T00:00:00Z', scope: { tenant_slug: 'child' }, cost_usd: 5 },
    ];
    expect(summarizeCredentialUsage('child', '2026-11', { history })).toEqual([
      {
        borrower_tenant: 'child',
        month: '2026-11',
        credential_ref: 'tenant:parent:anthropic',
        runs: 2,
        input_tokens: 210,
        output_tokens: 40,
        est_cost_usd: 50,
      },
    ]);
  });

  it.each([
    [79, 'ok'],
    [80, 'warn'],
    [100, 'exceeded'],
  ])('budget at $%s of $100 is %s', (spent, status) => {
    const history = () => [row('tenant:parent:anthropic', spent)];
    expect(assessCredentialBudget(lending, 'child', NOW, { history }).status).toBe(status);
  });

  it('notifies 80% and 100% once per grant, level and day from the scheduled job', () => {
    resetCredentialBudgetAlerts();
    const notify = vi.fn();
    const grant = {
      grant_id: 'GRT-B',
      scope: { tenant_slug: 'child', credential_lending: lending },
    } as unknown as GrantRecord;
    const run = (spent: number) =>
      runCredentialUsageMonthly({
        tenants: ['child'],
        listAllocations: () => [grant],
        now: NOW,
        history: () => [row('tenant:parent:anthropic', spent)],
        notify,
      });
    expect(run(85).alerts.map((alert) => alert.level)).toEqual(['warn']);
    run(85);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(run(120).alerts[0]!.level).toBe('exceeded');
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[1]![1].title).toMatch(/new runs stopped/);
  });
});
