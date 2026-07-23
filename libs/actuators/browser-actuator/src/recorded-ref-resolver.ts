/**
 * Resolves a Chrome-extension-recorded `{role, name, dom_path}` target
 * (`browser-recording.v1`, no selector ever) against a live Playwright page.
 *
 * This is the missing bridge between recording and Playwright execution: the
 * actuator's own `resolveRefSelector` only understands refs minted by its own
 * in-session `snapshot` op (`ctx.ref_map`), which never contains refs coming
 * from an externally recorded scenario. `resolveRefOrRecordedTarget` below
 * tries that existing path first and only falls back to this resolver.
 */
import type { Page } from '@playwright/test';
import { browserRuntimeHelpers, type BrowserSnapshotElement } from './browser-runtime-helpers.js';

export interface RecordedRefTarget {
  role?: string;
  name?: string;
  dom_path?: string;
  /**
   * Fail closed instead of trusting a role/name match alone when `dom_path`
   * is absent. Set by `browser-pipeline-helpers.ts` for secret-bearing fills
   * (`fill_ref` with `classification: 'secret_ref'`, and `fill_secret_ref`
   * always) and for any op whose recorded `risk` made it high-risk
   * (`params.high_risk`, gated separately by `enforceBrowserExtensionApproval`
   * for whether the action runs at all) — see `RecordedRefSpoofSuspectedError`
   * for the attack this (and the dom_path cross-check below) defend against.
   *
   * Known residual limitation (found by adversarial review, not yet closed):
   * `dom_path` is a coarse tag+nth-of-type ancestor path, not a stable
   * identity. An attacker with full same-origin DOM authorship control
   * (e.g. XSS) could in principle construct a decoy element at the exact
   * recorded structural position with the same role/name, defeating this
   * check by construction. This raises the bar significantly against casual
   * relabeling/content drift but is not a defense against a fully compromised
   * page. Closing that fully would need a stronger per-element identity
   * signal carried from recording time (`snapshot_hash` today only hashes
   * the whole page's interactive-element inventory, not one element).
   */
  requireDomPathMatch?: boolean;
}

export interface ResolvedRefSelector {
  selector: string;
  strategy: 'role_name' | 'dom_path';
}

export type RecordedRefExecutionContext = Record<string, unknown> & {
  ref_map?: Record<string, string>;
};

export class RecordedRefUnresolvedError extends Error {
  constructor(target: RecordedRefTarget) {
    super(
      `Could not resolve recorded ref (role=${target.role ?? '?'}, name=${target.name ?? '?'}` +
        `${target.dom_path ? `, dom_path=${target.dom_path}` : ''}) against the live page.`
    );
    this.name = 'RecordedRefUnresolvedError';
  }
}

export class RecordedRefAmbiguousError extends Error {
  constructor(target: RecordedRefTarget, candidates: string[]) {
    super(
      `Recorded ref (role=${target.role ?? '?'}, name=${target.name ?? '?'}) matched ` +
        `${candidates.length} elements on the live page; refusing to guess. Candidates: ${candidates.join(', ')}`
    );
    this.name = 'RecordedRefAmbiguousError';
  }
}

/**
 * A role/name match was found, but it could not be corroborated against the
 * element recorded at approval time. This is the defense against a page
 * (compromised, or just re-rendered) relabeling a DIFFERENT element with the
 * same accessible role+name as the one a human approved during recording —
 * without this check, `click_ref`/`fill_ref` would silently act on whatever
 * element the live page currently presents under that label, which for a
 * secret-bearing fill is a credential-exfiltration vector, not just a
 * mis-click. Thrown when `dom_path` disagrees with the role/name match, or
 * when `requireDomPathMatch` demands corroboration that isn't available.
 */
export class RecordedRefSpoofSuspectedError extends Error {
  constructor(target: RecordedRefTarget, detail: string) {
    super(
      `Refusing to resolve recorded ref (role=${target.role ?? '?'}, name=${target.name ?? '?'}): ${detail}. ` +
        'The live page may have relabeled or replaced the originally-approved element.'
    );
    this.name = 'RecordedRefSpoofSuspectedError';
  }
}

// Native tags whose implicit ARIA role kyberion needs to know about, since
// live-DOM role capture (browser-runtime-helpers.ts) only ever reads the
// explicit `role="..."` attribute — plain `<button>`/`<a>`/`<input>` elements
// report `role: null` there even though they are unambiguously interactive.
const IMPLICIT_ROLE_BY_TAG: Record<string, string> = {
  button: 'button',
  a: 'link',
  summary: 'button',
  select: 'combobox',
  textarea: 'textbox',
};

const IMPLICIT_ROLE_BY_INPUT_TYPE: Record<string, string> = {
  button: 'button',
  submit: 'button',
  reset: 'button',
  checkbox: 'checkbox',
  radio: 'radio',
  text: 'textbox',
  email: 'textbox',
  password: 'textbox',
  search: 'textbox',
  tel: 'textbox',
  url: 'textbox',
  number: 'textbox',
};

function normalize(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function effectiveRole(element: BrowserSnapshotElement): string {
  if (element.role) return normalize(element.role);
  if (element.tag === 'input') {
    const inputType = normalize(element.type) || 'text';
    return IMPLICIT_ROLE_BY_INPUT_TYPE[inputType] ?? 'textbox';
  }
  return IMPLICIT_ROLE_BY_TAG[element.tag] ?? '';
}

function matchesTarget(element: BrowserSnapshotElement, target: RecordedRefTarget): boolean {
  if (!element.visible) return false;
  if (target.role && effectiveRole(element) !== normalize(target.role)) return false;
  if (target.name && normalize(element.name) !== normalize(target.name)) return false;
  return Boolean(target.role || target.name);
}

/**
 * Resolve a recorded `{role, name, dom_path}` target into a Playwright
 * selector against the CURRENT state of `page`. Never guesses: zero matches
 * throws `RecordedRefUnresolvedError`, more than one throws
 * `RecordedRefAmbiguousError`.
 */
export async function resolveRecordedRefSelector(
  page: Page,
  target: RecordedRefTarget,
  opts: { maxElements?: number } = {}
): Promise<ResolvedRefSelector> {
  const captured = await browserRuntimeHelpers.captureSnapshotElements(
    page,
    opts.maxElements ?? 500
  );
  const matches = captured.elements.filter((element) => matchesTarget(element, target));

  if (matches.length === 1) {
    const candidateSelector = matches[0].selector;
    if (target.dom_path) {
      const sameElement = await page.evaluate(
        ({ domPath, candidateSelector }) => {
          const byDomPath = document.querySelectorAll(domPath);
          if (byDomPath.length !== 1) return false;
          const byCandidate = document.querySelector(candidateSelector);
          return byCandidate !== null && byDomPath[0] === byCandidate;
        },
        { domPath: target.dom_path, candidateSelector }
      );
      if (!sameElement) {
        throw new RecordedRefSpoofSuspectedError(
          target,
          `role/name matched "${candidateSelector}" but dom_path "${target.dom_path}" resolves to a ` +
            'different element (or a different count) on the live page'
        );
      }
    } else if (target.requireDomPathMatch) {
      throw new RecordedRefSpoofSuspectedError(
        target,
        'role/name matched, but no dom_path was recorded to corroborate element identity and this ' +
          'target requires one'
      );
    }
    return { selector: candidateSelector, strategy: 'role_name' };
  }
  if (matches.length > 1) {
    throw new RecordedRefAmbiguousError(
      target,
      matches.map((element) => element.selector)
    );
  }

  if (target.dom_path) {
    const count = await page.evaluate(
      (selector) => document.querySelectorAll(selector).length,
      target.dom_path
    );
    if (count === 1) return { selector: target.dom_path, strategy: 'dom_path' };
    if (count > 1) {
      throw new RecordedRefAmbiguousError(target, [`${target.dom_path} (${count} matches)`]);
    }
  }

  throw new RecordedRefUnresolvedError(target);
}

/**
 * Drop-in for the actuator's `resolveRefSelector(ctx, ref)` call sites: tries
 * the existing session-scoped `ctx.ref_map` lookup first (unchanged
 * behavior for live-snapshot-driven pipelines), and only on miss — and only
 * when a recorded target was supplied — falls back to
 * `resolveRecordedRefSelector`. The resolved selector is cached into the
 * returned `ctx.ref_map` so later steps referencing the same `ref` reuse it.
 */
export async function resolveRefOrRecordedTarget(
  ctx: RecordedRefExecutionContext,
  ref: string,
  page: Page,
  recordedTarget?: RecordedRefTarget
): Promise<{ selector: string; ctx: RecordedRefExecutionContext }> {
  try {
    return { selector: browserRuntimeHelpers.resolveRefSelector(ctx, ref), ctx };
  } catch (err) {
    // Only fall back on the specific "ref not in this session's ref_map"
    // condition — any other failure from resolveRefSelector should surface
    // as-is rather than being silently reinterpreted as "try the recording".
    const isRefMapMiss = err instanceof Error && err.message.includes('Unknown browser ref');
    if (!isRefMapMiss || (!recordedTarget?.role && !recordedTarget?.name)) throw err;
    const resolved = await resolveRecordedRefSelector(page, recordedTarget);
    return {
      selector: resolved.selector,
      ctx: { ...ctx, ref_map: { ...(ctx.ref_map ?? {}), [ref]: resolved.selector } },
    };
  }
}
