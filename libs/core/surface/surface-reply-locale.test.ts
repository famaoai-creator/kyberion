import { afterEach, describe, expect, it } from 'vitest';
import {
  deriveReplyLocale,
  enterReplyLocale,
  getReplyLocale,
  resolveLocale,
  resolveScopeLocale,
  runWithReplyLocale,
} from '../locale.js';
import { pathResolver } from '../path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from '../secure-io.js';
import { withExecutionContext } from '../governance.js';
import { buildSlackApprovalBlocks } from '../integrations/slack-approval-ui.js';
import { detectTextLocale } from '../locale-normalize.js';
import { t } from '../t.js';
import {
  formatSteeringRejection,
  SurfaceSteeringAuthorityError,
} from './surface-steering-authority.js';

const ORIGINAL_LOCALE = process.env.KYBERION_LOCALE;

afterEach(() => {
  enterReplyLocale(undefined);
  if (ORIGINAL_LOCALE === undefined) delete process.env.KYBERION_LOCALE;
  else process.env.KYBERION_LOCALE = ORIGINAL_LOCALE;
});

describe('chat reply locale follows the incoming message (IT-02)', () => {
  it('detects the language the user wrote in', () => {
    expect(detectTextLocale('資料を探してください')).toBe('ja');
    expect(detectTextLocale('please find the latest docs')).toBe('en');
    // ids, digits, acronyms and emoji say nothing about the language
    expect(detectTextLocale('REQ-FINAL-789')).toBeNull();
    expect(detectTextLocale('1')).toBeNull();
    expect(detectTextLocale('👍')).toBeNull();
    expect(detectTextLocale('')).toBeNull();
  });

  it('derives the reply locale: explicit > detected input language', () => {
    expect(deriveReplyLocale({ text: 'こんにちは' })).toBe('ja');
    expect(deriveReplyLocale({ text: 'hello there' })).toBe('en');
    expect(deriveReplyLocale({ explicit: 'ja', text: 'hello there' })).toBe('ja');
    expect(deriveReplyLocale({ explicit: 'en', text: 'こんにちは' })).toBe('en');
    expect(deriveReplyLocale({ text: '123' })).toBeUndefined();
  });

  it('renders Japanese input as ja and English input as en, whatever the operator locale is', () => {
    const error = new SurfaceSteeringAuthorityError('no_session_for_thread', {
      surface: 'slack',
      missionId: 'MSN-X',
    } as never);

    process.env.KYBERION_LOCALE = 'en';
    const ja = runWithReplyLocale(deriveReplyLocale({ text: 'ミッションを止めて' }), () =>
      formatSteeringRejection(error)
    );
    expect(ja).toContain('ミッション MSN-X のオーナーではありません');

    process.env.KYBERION_LOCALE = 'ja';
    const en = runWithReplyLocale(deriveReplyLocale({ text: 'please pause the mission' }), () =>
      formatSteeringRejection(error)
    );
    expect(en).toContain('This thread is not the owner of mission MSN-X');
  });

  it('lets an explicit locale win over the detected one', () => {
    process.env.KYBERION_LOCALE = 'en';
    const text = runWithReplyLocale(
      deriveReplyLocale({ explicit: 'ja', text: 'please pause the mission' }),
      () => t('surface:steering_paused', { missionId: 'MSN-1' })
    );
    expect(text).toBe('状態: ミッション MSN-1 を一時停止しました。');
    // and an explicit locale argument to t() still beats the turn locale
    const forced = runWithReplyLocale('ja', () =>
      t('surface:steering_paused', { missionId: 'MSN-1' }, 'en')
    );
    expect(forced).toBe('State: Paused mission MSN-1.');
  });

  it('falls back to resolveLocale() when nothing was detected and scopes the turn locale', () => {
    process.env.KYBERION_LOCALE = 'ja';
    expect(runWithReplyLocale(deriveReplyLocale({ text: '42' }), () => resolveLocale())).toBe('ja');
    runWithReplyLocale('en', () => {
      expect(getReplyLocale()).toBe('en');
    });
    expect(getReplyLocale()).toBeUndefined();
  });

  it('keeps an explicit resolveLocale() argument above the turn locale', () => {
    expect(runWithReplyLocale('en', () => resolveLocale({ explicit: 'ja' }))).toBe('ja');
  });
});

describe('replies with no language signal in the message (IT-02 follow-up)', () => {
  const tenant = 'zz-locale-test';
  const localePath = pathResolver.knowledge(`confidential/${tenant}/locale.json`);

  afterEach(() => {
    withExecutionContext('ecosystem_architect', () =>
      safeRmSync(pathResolver.knowledge(`confidential/${tenant}`), { recursive: true, force: true })
    );
  });

  // Tenant locale overlays live in the confidential tier: reading them needs an authorized role.
  const asArchitect = <T>(fn: () => T): T => withExecutionContext('ecosystem_architect', fn);

  function storeTenantLocale(locale: string): void {
    withExecutionContext('ecosystem_architect', () => {
      safeMkdir(pathResolver.knowledge(`confidential/${tenant}`), { recursive: true });
      safeWriteFile(localePath, JSON.stringify({ locale }));
    });
  }

  it('a button / digit payload falls through to the operator locale', () => {
    process.env.KYBERION_LOCALE = 'ja';
    expect(runWithReplyLocale(deriveReplyLocale({ text: '1' }), () => resolveLocale())).toBe('ja');
    process.env.KYBERION_LOCALE = 'en';
    expect(runWithReplyLocale(deriveReplyLocale({ text: undefined }), () => resolveLocale())).toBe(
      'en'
    );
  });

  it('uses the locale stored for the turn scope when the text carries no signal', () => {
    process.env.KYBERION_LOCALE = 'en';
    storeTenantLocale('ja');
    const scope = { tenant_slug: tenant };
    expect(asArchitect(() => deriveReplyLocale({ text: '1', scope }))).toBe('ja');
    // a language signal in the message and an explicit locale still win
    expect(asArchitect(() => deriveReplyLocale({ text: 'hello there', scope }))).toBe('en');
    expect(asArchitect(() => deriveReplyLocale({ explicit: 'en', text: '1', scope }))).toBe('en');
    expect(asArchitect(() => resolveScopeLocale(scope))).toBe('ja');
  });

  it('never throws or leaks a locale for an unknown or malformed scope', () => {
    process.env.KYBERION_LOCALE = 'en';
    expect(resolveScopeLocale({ tenant_slug: 'no-such-tenant-zz' })).toBeUndefined();
    expect(resolveScopeLocale({ tenant_slug: 'Not A Slug!' })).toBeUndefined();
    expect(resolveScopeLocale(undefined)).toBeUndefined();
  });

  it('proactive approval cards (no inbound message) use the operator / scope locale', () => {
    const record = {
      id: 'REQ-LOCALE-1',
      title: 'Ship it',
      summary: 'Ship the change',
      status: 'pending',
      severity: 'medium',
      scope: { tenant_slug: tenant },
    } as never;
    process.env.KYBERION_LOCALE = 'ja';
    const ja = buildSlackApprovalBlocks(record);
    expect(JSON.stringify(ja)).toContain(t('bridge:approval_severity_label', undefined, 'ja'));
    process.env.KYBERION_LOCALE = 'en';
    const en = buildSlackApprovalBlocks(record);
    expect(JSON.stringify(en)).toContain(t('bridge:approval_severity_label', undefined, 'en'));
    // a tenant with a stored locale overrides the operator default for its cards
    storeTenantLocale('ja');
    expect(asArchitect(() => JSON.stringify(buildSlackApprovalBlocks(record)))).toContain(
      t('bridge:approval_severity_label', undefined, 'ja')
    );
    // and an explicit locale argument still wins
    expect(JSON.stringify(buildSlackApprovalBlocks(record, undefined, 'en'))).toContain(
      t('bridge:approval_severity_label', undefined, 'en')
    );
  });
});
