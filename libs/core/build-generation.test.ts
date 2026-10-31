import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';
import {
  BUILD_GENERATION_RECEIPT_FILENAME,
  buildGenerationReceiptPath,
  publishBuildGenerationReceipt,
  readBuildGenerationIdentity,
  readBuildGenerationReceipt,
  type BuildGenerationReceipt,
} from './build-generation.js';

const FIXTURE_DIR = pathResolver.sharedTmp('build-generation-test/dist');

function receipt(overrides: Partial<BuildGenerationReceipt> = {}): BuildGenerationReceipt {
  return {
    schemaVersion: 1,
    generationId: 'gen-test-1',
    mode: 'repo',
    startedAt: '2026-10-31T00:00:00.000Z',
    finishedAt: '2026-10-31T00:01:00.000Z',
    result: 'completed',
    inputFingerprint: 'a'.repeat(64),
    configFingerprint: 'b'.repeat(64),
    toolVersions: { node: 'v24.0.0', typescript: '5.9.0', pnpm: '11.15.1' },
    inputStability: 'stable_observed',
    ...overrides,
  };
}

afterEach(() => {
  if (safeExistsSync(FIXTURE_DIR)) safeRmSync(FIXTURE_DIR, { recursive: true, force: true });
});

describe('build generation receipt', () => {
  it('round-trips a completed-generation receipt', () => {
    publishBuildGenerationReceipt(receipt(), FIXTURE_DIR);
    const read = readBuildGenerationReceipt(FIXTURE_DIR);
    expect(read).toEqual({ status: 'valid', receipt: receipt() });
  });

  it('writes the canonical receipt path inside the dist tree', () => {
    expect(buildGenerationReceiptPath(FIXTURE_DIR)).toBe(
      path.join(FIXTURE_DIR, BUILD_GENERATION_RECEIPT_FILENAME)
    );
  });

  it('refuses to publish anything that is not a completed stable-input generation', () => {
    for (const bad of [
      { ...receipt(), result: 'failed' as never },
      { ...receipt(), inputStability: 'changed_observed' as never },
      { ...receipt(), inputStability: 'unverifiable' as never },
    ]) {
      expect(() => publishBuildGenerationReceipt(bad, FIXTURE_DIR)).toThrow(/refusing/);
    }
    expect(safeExistsSync(buildGenerationReceiptPath(FIXTURE_DIR))).toBe(false);
  });

  it('classifies missing, malformed and legacy receipts without guessing green', () => {
    expect(readBuildGenerationReceipt(FIXTURE_DIR)).toEqual({ status: 'none' });

    safeMkdir(FIXTURE_DIR, { recursive: true });
    safeWriteFile(buildGenerationReceiptPath(FIXTURE_DIR), 'not json');
    expect(readBuildGenerationReceipt(FIXTURE_DIR).status).toBe('invalid');

    safeWriteFile(
      buildGenerationReceiptPath(FIXTURE_DIR),
      JSON.stringify({ schemaVersion: 99, generationId: 'old' })
    );
    expect(readBuildGenerationReceipt(FIXTURE_DIR).status).toBe('legacy');

    safeWriteFile(
      buildGenerationReceiptPath(FIXTURE_DIR),
      JSON.stringify({ ...receipt(), result: 'failed' })
    );
    expect(readBuildGenerationReceipt(FIXTURE_DIR).status).toBe('invalid');
  });
});

describe('readBuildGenerationIdentity', () => {
  it('reports a valid receipt with its id and input fingerprint', () => {
    publishBuildGenerationReceipt(receipt(), FIXTURE_DIR);
    expect(readBuildGenerationIdentity(FIXTURE_DIR)).toEqual({
      provenance: 'receipt',
      receiptId: 'gen-test-1',
      sourceFingerprint: 'a'.repeat(64),
    });
  });

  it('falls back to the agent-worktree stamp and then to none', () => {
    safeMkdir(FIXTURE_DIR, { recursive: true });
    safeWriteFile(path.join(FIXTURE_DIR, '.session-build-head'), 'deadbeefcafe\n');
    expect(readBuildGenerationIdentity(FIXTURE_DIR)).toEqual({
      provenance: 'stamp',
      head: 'deadbeefcafe',
    });
    safeRmSync(FIXTURE_DIR, { recursive: true, force: true });
    expect(readBuildGenerationIdentity(FIXTURE_DIR)).toEqual({ provenance: 'none' });
  });

  it('reports a legacy/invalid receipt honestly', () => {
    safeMkdir(FIXTURE_DIR, { recursive: true });
    safeWriteFile(buildGenerationReceiptPath(FIXTURE_DIR), '{broken');
    expect(readBuildGenerationIdentity(FIXTURE_DIR).provenance).toBe('legacy_receipt');
  });
});
