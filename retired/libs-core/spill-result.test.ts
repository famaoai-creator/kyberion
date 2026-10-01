import { afterEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync, safeSymlinkSync, safeWriteFile } from './secure-io.js';
import { readSpilledText, spillTextBestEffort } from './spill-result.js';

const spillDir = path.resolve(`active/shared/tmp/spill-result-${process.pid}`);
const spillSymlinkTarget = path.join(
  pathResolver.sharedTmp(),
  `spill-result-target-${process.pid}.txt`
);

afterEach(() => {
  safeRmSync(spillDir, { recursive: true, force: true });
  safeRmSync(spillSymlinkTarget, { force: true });
});

describe('spill-result (DH-14)', () => {
  it('writes oversized text with private permissions and returns an opaque locator', () => {
    const text = 'sensitive result '.repeat(400);
    const result = spillTextBestEffort(text, { thresholdChars: 10, spillDir });
    expect(result).toMatchObject({ value: text, spilled: true });
    expect(result.locator).toMatch(/^spill:[a-f0-9]{32}$/u);
    expect(readSpilledText(result.locator!, { spillDir })).toBe(text);
  });

  it('preserves inline values and fail-soft values', () => {
    expect(spillTextBestEffort('small', { thresholdChars: 10, spillDir })).toEqual({
      value: 'small',
      spilled: false,
    });
    const result = spillTextBestEffort('too large', {
      thresholdChars: 1,
      spillDir: `${spillDir}/file`,
    });
    expect(result.value).toBe('too large');
  });

  it('rejects path-bearing or malformed locators', () => {
    expect(() => readSpilledText(`${spillDir}/secret`)).toThrow('SPILL_LOCATOR_INVALID');
    expect(() => readSpilledText('spill:00000000000000000000000000000000', { spillDir })).toThrow(
      'SPILL_LOCATOR_MISSING'
    );
  });

  it('does not use a spill directory outside the repository root', () => {
    const outside = path.join(pathResolver.rootDir(), '..', 'spill-result-outside');
    expect(
      spillTextBestEffort('large secret', { thresholdChars: 1, spillDir: outside })
    ).toMatchObject({ spilled: false, value: 'large secret' });
    expect(() =>
      readSpilledText('spill:00000000000000000000000000000000', { spillDir: outside })
    ).toThrow('[RESOURCE_PATH_SCOPE]');
  });

  it('does not follow a symlinked spill file into another repository location', () => {
    const locator = 'spill:0123456789abcdef0123456789abcdef';
    const link = path.join(spillDir, `${locator.slice('spill:'.length)}.spill`);
    safeMkdir(spillDir, { recursive: true });
    safeWriteFile(spillSymlinkTarget, 'external content');
    safeSymlinkSync(spillSymlinkTarget, link);

    expect(() => readSpilledText(locator, { spillDir })).toThrow('[SPILL_LOCATOR_INVALID]');
  });
});
