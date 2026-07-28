// DA-06 PII・秘匿ガード — unit tests for the rule loader, the detectors
// (incl. マイナンバー check-digit and Luhn known-valid/invalid vectors), the
// masked-preview contract (raw matches never leave the scrubber) and the
// block/mask/override semantics of scrubContent.
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';
import {
  loadPiiRules,
  passesLuhn,
  passesMyNumberChecksum,
  scanContent,
  scrubContent,
} from './pii-scrubber.js';

let fixtureDir = '';

beforeAll(() => {
  fixtureDir = path.join(
    pathResolver.rootDir(),
    'active',
    'shared',
    'tmp',
    `pii-scrubber-da06-${randomUUID()}`
  );
  safeMkdir(fixtureDir, { recursive: true });
});

afterAll(() => {
  if (fixtureDir) safeRmSync(fixtureDir, { recursive: true, force: true });
});

function writeFixtureRules(name: string, content: string): string {
  const file = path.join(fixtureDir, name);
  safeWriteFile(file, content);
  return file;
}

describe('loadPiiRules (knowledge-sync-rules.json security.pii_patterns)', () => {
  it('loads the real rule table: 4 legacy secrets absorbed as block rules + JP PII detectors', () => {
    const rules = loadPiiRules();
    const byId = new Map(rules.map((rule) => [rule.id, rule]));
    for (const secret of ['API_KEY', 'OAUTH_SECRET', 'PRIVATE_KEY', 'GENERIC_SECRET']) {
      expect(byId.get(secret)).toMatchObject({ severity: 'secret', action: 'block' });
    }
    expect(byId.get('EMAIL_ADDRESS')).toMatchObject({ severity: 'pii', action: 'mask' });
    expect(byId.get('JP_PHONE_NUMBER')).toMatchObject({ severity: 'pii', action: 'mask' });
    expect(byId.get('JP_BANK_ACCOUNT')).toMatchObject({ severity: 'pii', action: 'mask' });
    expect(byId.get('JP_POSTAL_ADDRESS')).toMatchObject({ severity: 'pii', action: 'mask' });
    // マイナンバー / card numbers may not be retained (番号法 / PCI DSS) — block, not mask.
    expect(byId.get('JP_MY_NUMBER')).toMatchObject({
      severity: 'pii',
      action: 'block',
      validator: 'jp_mynumber',
    });
    expect(byId.get('CREDIT_CARD')).toMatchObject({
      severity: 'pii',
      action: 'block',
      validator: 'luhn',
    });
    // Deterministic codepoint order.
    const ids = rules.map((rule) => rule.id);
    expect(ids).toEqual([...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  });

  it('tolerates the legacy { name, regex } shape with secret/block defaults', () => {
    const file = writeFixtureRules(
      'legacy.json',
      JSON.stringify({ security: { pii_patterns: [{ name: 'LEGACY', regex: 'xyz-[0-9]{4}' }] } })
    );
    expect(loadPiiRules({ rulesPath: file })).toEqual([
      {
        id: 'LEGACY',
        description: '',
        severity: 'secret',
        action: 'block',
        pattern: 'xyz-[0-9]{4}',
      },
    ]);
  });

  it('fails closed: missing file, corrupt JSON, empty list, bad regex, unknown severity', () => {
    expect(() => loadPiiRules({ rulesPath: path.join(fixtureDir, 'nope.json') })).toThrow(
      /rules file not found/
    );
    expect(() =>
      loadPiiRules({ rulesPath: writeFixtureRules('corrupt.json', '{not json') })
    ).toThrow(/not valid JSON/);
    expect(() =>
      loadPiiRules({
        rulesPath: writeFixtureRules(
          'empty.json',
          JSON.stringify({ security: { pii_patterns: [] } })
        ),
      })
    ).toThrow(/non-empty array/);
    expect(() =>
      loadPiiRules({
        rulesPath: writeFixtureRules(
          'badregex.json',
          JSON.stringify({ security: { pii_patterns: [{ id: 'BAD', regex: '(unclosed' }] } })
        ),
      })
    ).toThrow(/does not compile/);
    expect(() =>
      loadPiiRules({
        rulesPath: writeFixtureRules(
          'badseverity.json',
          JSON.stringify({
            security: { pii_patterns: [{ id: 'X', regex: 'x', severity: 'meh' }] },
          })
        ),
      })
    ).toThrow(/unknown severity/);
  });
});

describe('check-digit validators', () => {
  it('Luhn: known-valid and known-invalid vectors', () => {
    expect(passesLuhn('4111111111111111')).toBe(true); // classic Visa test PAN
    expect(passesLuhn('4111 1111 1111 1111')).toBe(true);
    expect(passesLuhn('4111111111111112')).toBe(false); // check digit off by one
    expect(passesLuhn('123456789012')).toBe(false); // 12 digits — below PAN length
    expect(passesLuhn('12345678901234567890')).toBe(false); // 20 digits — above PAN length
  });

  it('マイナンバー 番号法 checksum: known-valid and known-invalid vectors', () => {
    // body 12345678901 → Σ P_n·Q_n = 212, 212 mod 11 = 3, check = 11 − 3 = 8.
    expect(passesMyNumberChecksum('123456789018')).toBe(true);
    expect(passesMyNumberChecksum('1234-5678-9018')).toBe(true);
    expect(passesMyNumberChecksum('123456789019')).toBe(false);
    // body 98765432109 → check digit 3.
    expect(passesMyNumberChecksum('987654321093')).toBe(true);
    expect(passesMyNumberChecksum('987654321094')).toBe(false);
    // remainder ≤ 1 → check digit 0.
    expect(passesMyNumberChecksum('000000000000')).toBe(true);
    expect(passesMyNumberChecksum('00000000000')).toBe(false); // 11 digits
  });
});

describe('scanContent', () => {
  it('detects email/phone with masked previews and line numbers — never the raw value', () => {
    const text = 'line one\nContact: taro.yamada@example.com or 090-1234-5678\n03-1234-5678';
    const { findings } = scanContent(text);
    const email = findings.find((f) => f.rule_id === 'EMAIL_ADDRESS');
    const phone = findings.find((f) => f.rule_id === 'JP_PHONE_NUMBER');
    expect(email).toMatchObject({ severity: 'pii', action: 'mask', line: 2, count: 1 });
    expect(email?.match_preview).toBe('ta…om');
    expect(phone).toMatchObject({ line: 2, count: 2 });
    const serialized = JSON.stringify(findings);
    expect(serialized).not.toContain('taro.yamada@example.com');
    expect(serialized).not.toContain('090-1234-5678');
  });

  it('fully masks secret previews', () => {
    const rawKey = `AIza${'A'.repeat(35)}`;
    const { findings } = scanContent(`key=${rawKey}`);
    const finding = findings.find((f) => f.rule_id === 'API_KEY');
    expect(finding).toMatchObject({ severity: 'secret', action: 'block', match_preview: '****' });
    expect(JSON.stringify(findings)).not.toContain(rawKey);
  });

  it('validator-gated rules: checksum-valid numbers flagged, invalid ones ignored', () => {
    expect(scanContent('マイナンバー: 1234-5678-9018').findings.map((f) => f.rule_id)).toContain(
      'JP_MY_NUMBER'
    );
    expect(
      scanContent('マイナンバー: 1234-5678-9019').findings.map((f) => f.rule_id)
    ).not.toContain('JP_MY_NUMBER');
    expect(scanContent('card 4111 1111 1111 1111').findings.map((f) => f.rule_id)).toContain(
      'CREDIT_CARD'
    );
    expect(scanContent('card 4111 1111 1111 1112').findings.map((f) => f.rule_id)).not.toContain(
      'CREDIT_CARD'
    );
    // Digit runs embedded in hex digests are not card/mynumber candidates.
    expect(
      scanContent('sha256: ab4111111111111111cd').findings.map((f) => f.rule_id)
    ).not.toContain('CREDIT_CARD');
  });

  it('bank account needs 支店/口座 context; postal needs 〒; dates are not phone numbers', () => {
    expect(scanContent('口座番号: 1234567').findings.map((f) => f.rule_id)).toContain(
      'JP_BANK_ACCOUNT'
    );
    expect(scanContent('serial 1234567').findings.map((f) => f.rule_id)).not.toContain(
      'JP_BANK_ACCOUNT'
    );
    expect(scanContent('〒100-0001 東京都千代田区').findings.map((f) => f.rule_id)).toContain(
      'JP_POSTAL_ADDRESS'
    );
    expect(scanContent('published 2026-07-28').findings).toEqual([]);
  });
});

describe('scrubContent', () => {
  it('masks PII to [REDACTED:{rule_id}] and keeps the text committable', () => {
    const result = scrubContent('Contact: taro@example.com / 090-1234-5678');
    expect(result.blocked).toBe(false);
    expect(result.scrubbed_text).toBe(
      'Contact: [REDACTED:EMAIL_ADDRESS] / [REDACTED:JP_PHONE_NUMBER]'
    );
    expect(result.applied).toEqual([
      { rule_id: 'EMAIL_ADDRESS', count: 1, overridden: false },
      { rule_id: 'JP_PHONE_NUMBER', count: 1, overridden: false },
    ]);
  });

  it('blocks on secrets — and still masks them in the returned text (defense in depth)', () => {
    const rawKey = `AIza${'B'.repeat(35)}`;
    const result = scrubContent(`token=${rawKey} plus secret: 'abcdefghij12345678'`);
    expect(result.blocked).toBe(true);
    expect(result.block_reasons).toEqual(['API_KEY', 'GENERIC_SECRET']);
    expect(result.scrubbed_text).not.toContain(rawKey);
    expect(result.scrubbed_text).toContain('[REDACTED:API_KEY]');
  });

  it('override downgrades listed block rules to mask; unlisted block rules stay blocking', () => {
    const rawKey = `AIza${'C'.repeat(35)}`;
    const overridden = scrubContent(`token=${rawKey}`, { override_rule_ids: ['API_KEY'] });
    expect(overridden.blocked).toBe(false);
    expect(overridden.applied).toEqual([{ rule_id: 'API_KEY', count: 1, overridden: true }]);
    expect(overridden.scrubbed_text).toBe('token=[REDACTED:API_KEY]');

    const partial = scrubContent(`token=${rawKey}\nマイナンバー: 123456789018`, {
      override_rule_ids: ['API_KEY'],
    });
    expect(partial.blocked).toBe(true);
    expect(partial.block_reasons).toEqual(['JP_MY_NUMBER']);
  });
});
