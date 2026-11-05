import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSecretStreamRedactor, getSecret, redactSecretValuesInText } from './secret-guard.js';
import {
  REDACTION_CIRCULAR_MARKER,
  REDACTION_DEPTH_LIMIT_MARKER,
  REDACTION_SIZE_LIMIT_MARKER,
  SECRET_REDACTION_LIMIT_ERROR_CODE,
  SecretRedactionLimitError,
  redactSecretsDeep,
} from './secret-redaction.js';
import {
  redactProviderStructuredResult,
  withRedactedProviderOutput,
} from '../provider/provider-output-redaction.js';

const TOKEN = 'redaction-walk-token-0123456789';
const PEM = [
  '-----BEGIN PRIVATE KEY-----',
  'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC',
  'q1w2e3r4t5y6u7i8o9p0aSdFgHjKl"zx',
  '-----END PRIVATE KEY-----',
].join('\n');

describe('redactSecretsDeep', () => {
  beforeEach(() => {
    vi.stubEnv('REDACTION_WALK_TOKEN', TOKEN);
    getSecret('REDACTION_WALK_TOKEN');
  });

  afterEach(() => vi.unstubAllEnvs());

  it('masks registered secrets in nested values and keys without mutating the input', () => {
    const input = {
      answer: `use ${TOKEN}`,
      nested: { list: ['ok', { deep: TOKEN }], [TOKEN]: 1 },
      count: 3,
      flag: true,
      nothing: null,
    };
    const out = redactSecretsDeep(input);
    expect(JSON.stringify(out)).not.toContain(TOKEN);
    expect(out.answer).toBe('use [REDACTED_SECRET]');
    expect(out.nested.list[1]).toEqual({ deep: '[REDACTED_SECRET]' });
    expect(out.nested).toHaveProperty('[REDACTED_SECRET]', 1);
    expect(out.count).toBe(3);
    expect(out.flag).toBe(true);
    expect(input.answer).toBe(`use ${TOKEN}`);
  });

  it('replaces containers beyond the depth cap with a marker (fail closed)', () => {
    const input = { a: { b: { c: { d: TOKEN } } } };
    const out = redactSecretsDeep(input, { maxDepth: 2 }) as unknown as { a: { b: unknown } };
    expect(out.a.b).toBe(REDACTION_DEPTH_LIMIT_MARKER);
    expect(JSON.stringify(out)).not.toContain(TOKEN);
  });

  it('is cycle-safe and keeps shared (non-cyclic) references walkable', () => {
    const shared = { value: TOKEN };
    const node: Record<string, unknown> = { shared, again: shared };
    node.self = node;
    const out = redactSecretsDeep(node) as {
      self: unknown;
      shared: { value: string };
      again: { value: string };
    };
    expect(out.self).toBe(REDACTION_CIRCULAR_MARKER);
    expect(out.shared.value).toBe('[REDACTED_SECRET]');
    expect(out.again.value).toBe('[REDACTED_SECRET]');
  });

  it('caps the number of visited nodes', () => {
    const out = redactSecretsDeep(
      Array.from({ length: 10 }, () => TOKEN),
      { maxNodes: 4 }
    );
    expect(out.slice(3)).toEqual(Array(7).fill(REDACTION_SIZE_LIMIT_MARKER));
  });

  it("fails closed with a classified error under onLimit: 'throw' (typed results keep their shape)", () => {
    const wide = Array.from({ length: 10 }, () => ({ value: TOKEN }));
    expect(() => redactSecretsDeep(wide, { maxNodes: 4, onLimit: 'throw' })).toThrow(
      SecretRedactionLimitError
    );
    try {
      redactSecretsDeep({ a: { b: { c: 1 } } }, { maxDepth: 2, onLimit: 'throw' });
      throw new Error('expected a throw');
    } catch (error) {
      expect(error).toBeInstanceOf(SecretRedactionLimitError);
      expect((error as SecretRedactionLimitError).code).toBe(SECRET_REDACTION_LIMIT_ERROR_CODE);
      expect((error as SecretRedactionLimitError).limit).toBe('depth');
      expect((error as Error).message).not.toContain(TOKEN);
    }
  });

  it('structured provider results never come back with a marker in place of a value', async () => {
    const huge = { items: Array.from({ length: 25_000 }, (_, i) => ({ id: i })) };
    expect(() => redactProviderStructuredResult(huge)).toThrow(SECRET_REDACTION_LIMIT_ERROR_CODE);
    await expect(withRedactedProviderOutput(async () => huge)).rejects.toThrow(
      SECRET_REDACTION_LIMIT_ERROR_CODE
    );
    await expect(withRedactedProviderOutput(async () => ({ answer: TOKEN }))).resolves.toEqual({
      answer: '[REDACTED_SECRET]',
    });
  });

  it('masks a multi-line PEM both raw and JSON-escaped (the stringify bypass)', () => {
    const extraSecrets = [PEM];
    const rawOut = redactSecretsDeep({ key: PEM, wrapped: `x${PEM}y` }, { extraSecrets });
    expect(rawOut).toEqual({ key: '[REDACTED_SECRET]', wrapped: 'x[REDACTED_SECRET]y' });

    // A model that re-emits the key inside a JSON string produces \n / \" escapes.
    const escapedText = JSON.stringify({ leaked: PEM });
    expect(escapedText).not.toContain(PEM);
    const masked = redactSecretValuesInText(escapedText, { extraSecrets });
    expect(masked).toBe('{"leaked":"[REDACTED_SECRET]"}');
  });

  it('walks Map, Set and Error values', () => {
    const out = redactSecretsDeep({
      map: new Map([['k', TOKEN]]),
      set: new Set([TOKEN]),
      error: new Error(`boom ${TOKEN}`),
    });
    expect(out.map.get('k')).toBe('[REDACTED_SECRET]');
    expect([...out.set]).toEqual(['[REDACTED_SECRET]']);
    expect(out.error.message).toBe('boom [REDACTED_SECRET]');
  });
});

describe('createSecretStreamRedactor', () => {
  it('masks a secret split across chunk boundaries and flushes the held tail', () => {
    const redactor = createSecretStreamRedactor({ extraSecrets: [TOKEN] });
    const pieces = ['hello ', TOKEN.slice(0, 5), TOKEN.slice(5, 20), TOKEN.slice(20), ' bye re'];
    const emitted = pieces.map((piece) => redactor.push(piece));
    const all = emitted.join('') + redactor.flush();
    expect(all).toBe('hello [REDACTED_SECRET] bye re');
    for (const chunk of emitted) expect(chunk).not.toContain(TOKEN.slice(0, 5));
  });

  it('emits text immediately when no suffix could begin a secret', () => {
    const redactor = createSecretStreamRedactor({ extraSecrets: [TOKEN] });
    expect(redactor.push('plain text.')).toBe('plain text.');
    expect(redactor.flush()).toBe('');
  });

  it('masks a longer secret B whole when it contains a shorter secret A across a chunk boundary', () => {
    const inner = 'inner-secret-AAAA';
    const outer = `outer-prefix-${inner}-outer-suffix-BBBB`;
    const redactor = createSecretStreamRedactor({ extraSecrets: [inner, outer] });
    const split = outer.indexOf(inner) + inner.length; // chunk ends right after A
    const emitted = [
      redactor.push(`x ${outer.slice(0, split)}`),
      redactor.push(`${outer.slice(split)} y`),
    ];
    const all = emitted.join('') + redactor.flush();
    expect(all).toBe('x [REDACTED_SECRET] y');
    expect(all).not.toContain('outer-suffix');
    for (const chunk of emitted) expect(chunk).not.toContain('outer-prefix');
  });
});
