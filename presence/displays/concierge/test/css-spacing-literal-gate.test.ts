import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { safeLstat, safeReadFile, safeReaddir } from '@agent/core/secure-io';

/**
 * MSN-SHELL-IA §5 — spacing comes from `--kb-ui-space-*` only. This gate
 * fails when a concierge stylesheet gains a literal `px` value in a margin,
 * padding or gap declaration. Files that already had some are allowlisted
 * with their current count as a ratchet: the count may only go down, and
 * when it does, lower the number here in the same change.
 *
 * The generated shared contract (`kyberion-ui.css`, `kyberion-ui-tokens.css`)
 * is produced from `knowledge/public/design-patterns/web/kyberion-ui.source.css`
 * and is not scanned here.
 */
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const GENERATED = new Set(['app/kyberion-ui.css', 'app/kyberion-ui-tokens.css']);

/** Literal-px spacing declarations per file, as of MSN-SHELL-IA-20261105. Ratchet down only. */
const BASELINE: Readonly<Record<string, number>> = {
  'app/globals.css': 8,
  'app/ops/globals.css': 5,
  'components/ops/dialogue-room.css': 44,
  'components/ops/discussion-room.css': 48,
};

const SPACING_PROPERTY = /^(?:margin|padding|gap|row-gap|column-gap)(?:-[a-z-]+)?$/;
const LITERAL_PX = /(?:^|[\s(,])-?(?:\d*\.)?\d+px\b/;

/** Declarations like `padding: 2px 10px` whose value carries a non-zero literal px. */
function countSpacingPxLiterals(css: string): number {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let count = 0;
  for (const match of text.matchAll(/([a-z-]+)\s*:\s*([^;{}]+)/g)) {
    const [, property, value] = match;
    if (!SPACING_PROPERTY.test(property)) continue;
    const nonZero = value.replace(/(?:^|[\s(,])-?0px\b/g, ' ');
    if (LITERAL_PX.test(nonZero)) count += 1;
  }
  return count;
}

function cssFiles(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const name of safeReaddir(dir).sort()) {
    const abs = path.join(dir, name);
    const relPath = rel ? `${rel}/${name}` : name;
    if (safeLstat(abs).isDirectory()) out.push(...cssFiles(abs, relPath));
    else if (name.endsWith('.css') && !GENERATED.has(relPath)) out.push(relPath);
  }
  return out;
}

describe('concierge CSS spacing literal gate', () => {
  it('counts only non-zero px in margin / padding / gap declarations', () => {
    expect(countSpacingPxLiterals('.a { padding: 2px 10px; border: 1px solid; }')).toBe(1);
    expect(countSpacingPxLiterals('.a { margin: 0px; gap: var(--kb-ui-space-2); }')).toBe(0);
    expect(countSpacingPxLiterals('.a { margin-top: calc(var(--x) + 4px); }')).toBe(1);
    expect(countSpacingPxLiterals('/* padding: 4px */ .a { width: 20px; }')).toBe(0);
    expect(countSpacingPxLiterals('.a { column-gap: 12px; row-gap:8px }')).toBe(2);
  });

  it('never adds a literal px spacing value (ratchet)', () => {
    const counts = Object.fromEntries(
      cssFiles(SRC).map((file) => [
        file,
        countSpacingPxLiterals(String(safeReadFile(path.join(SRC, file), { encoding: 'utf8' }))),
      ])
    );
    const over = Object.entries(counts)
      .filter(([file, count]) => count > (BASELINE[file] ?? 0))
      .map(([file, count]) => `${file}: ${count} > ${BASELINE[file] ?? 0}`);
    expect(over, 'use --kb-ui-space-* tokens instead of literal px').toEqual([]);
    const stale = Object.entries(BASELINE)
      .filter(([file, allowed]) => (counts[file] ?? 0) < allowed)
      .map(([file, allowed]) => `${file}: ${counts[file] ?? 0} < ${allowed}`);
    expect(stale, 'the count went down: lower BASELINE to lock it in').toEqual([]);
  });
});
