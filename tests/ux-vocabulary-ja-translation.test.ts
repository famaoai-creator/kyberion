import { describe, expect, it } from 'vitest';
import vocabulary from '../knowledge/product/orchestration/user-facing-vocabulary.json';

/**
 * The shell-UX keys (`ux_a_*`, `ux_b_*`) are read by Japanese operators first:
 * a `ja` value that is just the English copy means the string was never
 * translated (an English "なぜ必要か" line on a Japanese card). Proper nouns
 * and symbols that read the same in both languages go in the allowlist.
 */
const SAME_IN_BOTH: ReadonlySet<string> = new Set<string>([]);

type Entry = { en?: string; ja?: string };

function shellUxEntries(): Array<[string, Entry]> {
  const domains = (vocabulary as { domains: Record<string, Record<string, Entry>> }).domains;
  return Object.values(domains).flatMap((entries) =>
    Object.entries(entries).filter(([key]) => /^ux_[ab]_/u.test(key))
  );
}

describe('shell UX vocabulary', () => {
  it('has shell-UX keys to check', () => {
    expect(shellUxEntries().length).toBeGreaterThan(50);
  });

  it('gives every ux_a_/ux_b_ key a real Japanese translation', () => {
    const untranslated = shellUxEntries()
      .filter(([key]) => !SAME_IN_BOTH.has(key))
      .filter(([, entry]) => !entry.ja?.trim() || entry.ja.trim() === entry.en?.trim())
      .map(([key]) => key);
    expect(untranslated).toEqual([]);
  });
});
