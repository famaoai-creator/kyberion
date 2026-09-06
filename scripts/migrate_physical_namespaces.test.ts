import { describe, expect, it } from 'vitest';

import { readTextFile } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import {
  feedbackScopes,
  intentScopes,
  ledgerScopes,
  promotionScopes,
  parseArgs,
} from './migrate_physical_namespaces.js';

describe('physical namespace migration CLI', () => {
  it('defaults to a non-mutating all-kinds dry-run', () => {
    expect(parseArgs([])).toEqual({ kind: 'all', apply: false });
  });

  it('requires an explicit apply flag and supports all record kinds', () => {
    expect(parseArgs(['--kind', 'all'])).toEqual({ kind: 'all', apply: false });
    expect(parseArgs(['--kind', 'schedule', '--apply'])).toEqual({
      kind: 'schedule',
      apply: true,
    });
  });

  it('supports feedback, intent, ledger, and promotion migration kinds', () => {
    expect(parseArgs(['--kind', 'feedback'])).toEqual({ kind: 'feedback', apply: false });
    expect(parseArgs(['--kind', 'intent'])).toEqual({ kind: 'intent', apply: false });
    expect(parseArgs(['--kind', 'ledger'])).toEqual({ kind: 'ledger', apply: false });
    expect(parseArgs(['--kind', 'promotion'])).toEqual({ kind: 'promotion', apply: false });
    expect(() => parseArgs(['--kind', 'unknown'])).toThrow('Unsupported --kind: unknown');
  });

  it('quarantines unscoped promotion candidates instead of inferring a tenant', () => {
    const root = pathResolver.sharedTmp(`physical-namespace-promotion-test/${process.pid}`);
    const source = `${root}/promotion-queue.jsonl`;
    safeMkdir(root, { recursive: true });
    safeWriteFile(source, '{"id":"mem-1","status":"pending"}\n');
    expect(promotionScopes(source)).toMatchObject({ disposition: 'unscoped-legacy' });
    safeRmSync(root, { recursive: true, force: true });
  });

  it('quarantines unscoped feedback instead of guessing tenant ownership', () => {
    const root = pathResolver.sharedTmp(`physical-namespace-feedback-test/${process.pid}`);
    const source = `${root}/knowledge-human.jsonl`;
    safeMkdir(root, { recursive: true });
    safeWriteFile(source, '{"document_path":"knowledge/product/foo.md","verdict":"useful"}\n');
    expect(feedbackScopes(source)).toMatchObject({ disposition: 'unscoped-legacy' });
    safeRmSync(root, { recursive: true, force: true });
  });

  it('keeps intent memory and ledger records unscoped when tenant ownership is absent', () => {
    const root = pathResolver.sharedTmp(`physical-namespace-intent-ledger-test/${process.pid}`);
    const intent = `${root}/intent-contract-memory.json`;
    const ledger = `${root}/assets.jsonl`;
    safeMkdir(root, { recursive: true });
    safeWriteFile(intent, JSON.stringify({ version: '1.0.0', entries: [{ intent_id: 'x' }] }));
    safeWriteFile(ledger, '{"asset_id":"ing-x","target_path":"knowledge/product/x.md"}\n');
    expect(intentScopes(intent)).toMatchObject({ disposition: 'unscoped-legacy' });
    expect(ledgerScopes(ledger)).toMatchObject({ disposition: 'unscoped-legacy' });
    safeRmSync(root, { recursive: true, force: true });
  });

  it('rejects unsafe or non-object JSONL records before scope inference', () => {
    const root = pathResolver.sharedTmp(`physical-namespace-shape-test/${process.pid}`);
    const feedback = `${root}/feedback.jsonl`;
    const ledger = `${root}/ledger.jsonl`;
    const promotion = `${root}/promotion.jsonl`;
    safeMkdir(root, { recursive: true });
    safeWriteFile(feedback, '[1]\n');
    safeWriteFile(ledger, '{"visible_to":[1]}\n');
    safeWriteFile(promotion, '{"scope":[]}\n');

    expect(feedbackScopes(feedback)).toMatchObject({ disposition: 'invalid' });
    expect(ledgerScopes(ledger)).toMatchObject({ disposition: 'invalid' });
    expect(promotionScopes(promotion)).toMatchObject({ disposition: 'invalid' });
    safeRmSync(root, { recursive: true, force: true });
  });

  it('rejects dangerous keys in intent memory before reading entries', () => {
    const root = pathResolver.sharedTmp(`physical-namespace-dangerous-json-test/${process.pid}`);
    const intent = `${root}/intent-contract-memory.json`;
    safeMkdir(root, { recursive: true });
    safeWriteFile(intent, '{"entries":[{"__proto__":{"tenant_slug":"acme"}}]}');

    expect(intentScopes(intent)).toMatchObject({ disposition: 'invalid' });
    safeRmSync(root, { recursive: true, force: true });
  });

  it('routes migration plans through the shared script printer', () => {
    const source = readTextFile(pathResolver.rootResolve('scripts/migrate_physical_namespaces.ts'));

    expect(source).not.toContain('console.log');
    expect(source).not.toContain('console.error');
    expect(source).toContain('run: ({ argv, print }) => main(argv, print)');
    expect(source).toContain('isRecord, nowIso, readTextFile');
  });
});
