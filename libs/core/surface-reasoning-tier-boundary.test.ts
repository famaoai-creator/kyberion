import { describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeReadFile } from './secure-io.js';

/**
 * Registration ceremony (SO-05). The surface conversation front
 * (`runSurfaceConversation` / `runSurfaceMessageConversation` in
 * surface-runtime-orchestrator.ts) and the intent-compile helpers it calls
 * (intent-contract.ts) are the only reasoning-bearing calls on the surface
 * conversation path. Every one of them must declare a `model_tier` so the
 * conversation front stays on fast/standard by default instead of silently
 * drifting onto whatever the backend's default model is (see SO-05 plan
 * §1.6). A hit here means a new reasoning call was added to one of these
 * files without a tier declaration — either add `{ model_tier: '...' }` at
 * the call site or add a reviewed exception to the allowlist below.
 */

interface ScanTarget {
  file: string;
  /** Literal text the call expression starts with, e.g. "handle.ask(". */
  pattern: string;
  label: string;
}

const SCAN_TARGETS: ScanTarget[] = [
  {
    file: 'libs/core/surface-runtime-orchestrator.ts',
    pattern: 'handle.ask(',
    label: 'surface agent handle.ask()',
  },
  {
    file: 'libs/core/surface-runtime-orchestrator.ts',
    pattern: 'compileUserIntentFlow(',
    label: 'compileUserIntentFlow() from the surface conversation front',
  },
  {
    file: 'libs/core/intent-contract.ts',
    pattern: 'getReasoningBackend().prompt(',
    label: 'defaultAsk() reasoning backend prompt call',
  },
  // SO-05 back half: orchestrator-JUDGMENT call sites (deep by default),
  // distinct from the conversation-front call sites above (fast/standard).
  {
    file: 'libs/core/intent-reconciliation.ts',
    pattern: 'backend.prompt(',
    label: 'reconcileCompletion() LLM tightening pass',
  },
  {
    file: 'libs/core/mission-lifecycle.ts',
    pattern: 'reconcileCompletion(',
    label: 'mission finish-time IL-04 completion reconciliation',
  },
  {
    file: 'libs/core/surface-mission-steering.ts',
    pattern: 'reconcileCompletion(',
    label: 'mission-steering finish verb IL-04 completion reconciliation',
  },
];

/**
 * Reviewed exceptions: {file, callSiteSnippet}. `callSiteSnippet` must be a
 * substring of the offending call expression (post comment-strip) unique
 * enough to identify the specific call site being excused.
 */
const ALLOWLIST: Array<{ file: string; callSiteSnippet: string; reason: string }> = [];

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * From `matchIndex` (start of a pattern like "handle.ask(") extract the full
 * call expression up to its matching close paren, via paren-depth counting.
 * Good enough for this repo's code style (matches the KD-04 boundary test's
 * "not a full TS parser" tradeoff) — nested calls/object literals inside the
 * arguments are handled correctly since only `(`/`)` affect depth.
 */
function extractCallExpression(source: string, matchIndex: number, pattern: string): string {
  const openIndex = matchIndex + pattern.length - 1;
  let depth = 0;
  let i = openIndex;
  for (; i < source.length; i++) {
    if (source[i] === '(') depth++;
    else if (source[i] === ')') {
      depth--;
      if (depth === 0) {
        i++;
        break;
      }
    }
  }
  return source.slice(matchIndex, i);
}

function findCallSites(source: string, pattern: string): string[] {
  const clean = stripComments(source);
  const sites: string[] = [];
  let fromIndex = 0;
  for (;;) {
    const idx = clean.indexOf(pattern, fromIndex);
    if (idx < 0) break;
    sites.push(extractCallExpression(clean, idx, pattern));
    fromIndex = idx + pattern.length;
  }
  return sites;
}

function isAllowlisted(file: string, callSite: string): boolean {
  return ALLOWLIST.some((entry) => entry.file === file && callSite.includes(entry.callSiteSnippet));
}

describe('surface reasoning tier boundary (SO-05)', () => {
  it('every reasoning call on the surface conversation front declares model_tier', () => {
    const repoRoot = pathResolver.rootDir();
    const offenders: string[] = [];

    for (const target of SCAN_TARGETS) {
      const source = safeReadFile(`${repoRoot}/${target.file}`, { encoding: 'utf8' }) as string;
      const callSites = findCallSites(source, target.pattern);
      expect(
        callSites.length,
        `expected at least one ${target.label} call site in ${target.file} — scan pattern may be stale`
      ).toBeGreaterThan(0);

      for (const callSite of callSites) {
        if (/model_tier/.test(callSite)) continue;
        if (isAllowlisted(target.file, callSite)) continue;
        offenders.push(`${target.file}: ${target.label}: ${callSite.replace(/\s+/g, ' ').trim()}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('the allowlist itself only covers call sites that actually exist and lack a declaration', () => {
    const repoRoot = pathResolver.rootDir();

    for (const entry of ALLOWLIST) {
      const target = SCAN_TARGETS.find((t) => t.file === entry.file);
      expect(target, `allowlist entry references an unscanned file: ${entry.file}`).toBeTruthy();
      const source = safeReadFile(`${repoRoot}/${entry.file}`, { encoding: 'utf8' }) as string;
      const callSites = findCallSites(source, target!.pattern);
      const matched = callSites.filter((callSite) => callSite.includes(entry.callSiteSnippet));
      expect(
        matched.length,
        `stale allowlist entry (no matching call site found): ${entry.file} / ${entry.callSiteSnippet}`
      ).toBeGreaterThan(0);
    }
  });
});
