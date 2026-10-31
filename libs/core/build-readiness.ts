/**
 * Shared build-readiness model and judgment.
 *
 * Plan: kyberion-reliability §3.3 — a build is judged by *what* it compiled,
 * not by *how many seconds old* it is. Doctor (`repo-build.receipt`),
 * `baseline_build_readiness` and `check:stale-dist` must all observe the same
 * facts. Core owns the pure result type and the judgment; the canonical
 * input/emit scan lives in `scripts/` (check_stale_dist +
 * check_dist_workspace_imports), so the scan is injected through a seam —
 * core never imports `scripts/`.
 *
 * States (never collapsed to a boolean inside this module):
 *
 *   fresh                — every owned target's inputs match the recorded build
 *   stale                — a specific target disagrees with its inputs/emit
 *   missing              — the compiler entry tree does not exist at all
 *   building             — the compiler-outputs mutex is held; observation is
 *                          deferred (a probe never auto-repairs, never consumes
 *                          repair budget, and must re-observe afterwards)
 *   changed_during_scan  — compiler inputs moved while they were being
 *                          observed, so no single generation was inspected
 *   unknown              — the scan could not judge (errors, absent inspector,
 *                          unverifiable input stability). Stops — never green.
 */

import { createSeam, coreSeamCatalog } from './seam.js';

export type BuildReadinessState =
  'fresh' | 'stale' | 'missing' | 'building' | 'changed_during_scan' | 'unknown';

/** Reason codes carried by findings; the stale-target codes intentionally
 *  reuse the `check_stale_dist` vocabulary so both surfaces agree. */
export type BuildFindingCode =
  | 'source_changed_since_build'
  | 'unrecorded_source'
  | 'source_newer_than_dist'
  | 'dist_missing'
  | 'emit_missing'
  | 'orphaned_emit'
  | 'import_violation'
  | 'scan_failed'
  | (string & {});

export interface BuildReadinessFinding {
  /** Owned output tree the finding belongs to (e.g. `root:scripts`, `libs/core`). */
  target: string;
  code: BuildFindingCode;
  detail?: string;
  sourceFile?: string | null;
  distFile?: string | null;
}

export type BuildGenerationProvenance = 'receipt' | 'legacy_receipt' | 'stamp' | 'none';

/**
 * Identity of the compiler generation that was checked. `provenance` says
 * where the identity came from: a completed-generation receipt (R12), a
 * legacy/corrupt receipt, the agent-worktree `dist/.session-build-head` stamp,
 * or nothing. A receipt is evidence about a generation — it never grants
 * freshness on its own; only the scan does.
 */
export interface BuildGenerationIdentity {
  provenance: BuildGenerationProvenance;
  /** Completed-generation receipt id when one is published. */
  receiptId?: string;
  /** Compiler-input fingerprint recorded by the receipt/stamp. */
  sourceFingerprint?: string;
  /** Git HEAD recorded at build time (agent-worktree stamp). */
  head?: string;
  /** Why a legacy/invalid receipt could not be trusted, when relevant. */
  detail?: string;
}

/**
 * The facts one stable observation of the compiler outputs produced.
 * Scripts-side inspectors fill this in; `judgeBuildReadiness` is total over it.
 */
export interface BuildReadinessInspection {
  /** Compiler-outputs mutex was held — nothing was inspected. */
  deferred: boolean;
  /** The compiler entry tree (dist/scripts) exists. */
  entrypointPresent: boolean;
  /** Bare-specifier resolution failures found inside dist output. */
  importViolations: string[];
  /** Positive staleness/emit findings — real disagreements, not scan errors. */
  staleFindings: BuildReadinessFinding[];
  /** Targets the scan could not judge at all (never counted as stale). */
  scanFailures: BuildReadinessFinding[];
  /** Free-form failure of the inspection itself, when it partially ran. */
  scanError?: string;
  /** Compiler-input fingerprints bracketing the observation (stability). */
  inputFingerprintBefore?: string;
  inputFingerprintAfter?: string;
  generation?: BuildGenerationIdentity;
}

export interface BuildReadinessResult {
  state: BuildReadinessState;
  /** Machine-stable reason code: the state, or the driving finding's code. */
  code: string;
  /** Human-facing `what — why | next` detail. */
  detail: string;
  /** Primary target that drove the judgment, when there is one. */
  target?: string;
  findings: BuildReadinessFinding[];
  scanFailures: BuildReadinessFinding[];
  generation: BuildGenerationIdentity;
}

const NO_GENERATION: BuildGenerationIdentity = { provenance: 'none' };

export function judgeBuildReadiness(inspection: BuildReadinessInspection): BuildReadinessResult {
  const generation = inspection.generation ?? NO_GENERATION;
  const base = {
    findings: inspection.staleFindings,
    scanFailures: inspection.scanFailures,
    generation,
  };

  // 1. A held compiler-outputs lock means a build (or another inspector) owns
  //    the tree. Defer — a probe never repairs and never guesses the outcome.
  if (inspection.deferred) {
    return {
      ...base,
      state: 'building',
      code: 'compiler_build_in_progress',
      detail:
        'compiler outputs are locked by a running build or inspection — observation deferred; re-check after it completes',
    };
  }

  // 2. No entry tree at all — nothing was built here.
  if (!inspection.entrypointPresent) {
    return {
      ...base,
      state: 'missing',
      code: 'missing_entrypoint',
      target: 'dist/scripts',
      detail: 'compiler entry directory dist/scripts is missing — run `pnpm build`',
    };
  }

  // 3. Positive disagreements win over uncertainty: a recorded stale target or
  //    a broken dist import is real evidence whatever else failed.
  const importFindings: BuildReadinessFinding[] = inspection.importViolations.map((detail) => ({
    target: 'dist-imports',
    code: 'import_violation' as const,
    detail,
  }));
  const stale = [...inspection.staleFindings, ...importFindings];
  if (stale.length > 0) {
    const first = stale[0]!;
    return {
      ...base,
      findings: stale,
      state: 'stale',
      code: first.code,
      target: first.target,
      detail:
        `${stale.length} dist target(s) disagree with their compiler inputs` +
        ` — first: ${first.target} (${first.code}${first.detail ? `: ${first.detail}` : ''})` +
        ' — run `pnpm build`',
    };
  }

  // 4. Nothing proven stale, but part of the tree could not be judged — stop.
  if (inspection.scanError || inspection.scanFailures.length > 0) {
    const first = inspection.scanFailures[0];
    const detail = inspection.scanError
      ? inspection.scanError
      : `${inspection.scanFailures.length} dist target(s) could not be inspected` +
        (first ? ` — first: ${first.target}${first.detail ? ` (${first.detail})` : ''}` : '');
    return {
      ...base,
      state: 'unknown',
      code: 'scan_failed',
      detail: `build readiness could not be fully determined — ${detail}`,
    };
  }

  // 5. The scan judged every target but inputs moved while it ran — the result
  //    does not describe any single generation.
  if (
    inspection.inputFingerprintBefore !== undefined &&
    inspection.inputFingerprintAfter !== undefined &&
    inspection.inputFingerprintBefore !== inspection.inputFingerprintAfter
  ) {
    return {
      ...base,
      state: 'changed_during_scan',
      code: 'changed_during_scan',
      detail:
        'compiler inputs changed while they were being inspected — re-run the check before trusting any result',
    };
  }

  // 6. Every owned target agrees with its inputs and the observation was stable.
  return {
    ...base,
    state: 'fresh',
    code: 'fresh',
    detail: 'compiler outputs match the recorded build inputs',
  };
}

/* ------------------------------------------------------------------ *
 * Inspector seam — scripts/ installs the canonical scan here.          *
 * ------------------------------------------------------------------ */

export type BuildReadinessInspector = () => Promise<BuildReadinessInspection>;

const buildReadinessSeam = createSeam<BuildReadinessInspector>({
  key: 'build.readiness-inspector',
  multiplicity: 'sole',
  catalog: coreSeamCatalog,
  owner: 'libs/core/build-readiness.ts',
});
const inspectorDisposers = new Map<string, () => void>();

const INSPECTOR_PROVIDER_ID = 'baseline-compiler-outputs';

export function registerBuildReadinessInspector(inspector: BuildReadinessInspector): () => void {
  const dispose = buildReadinessSeam.register(INSPECTOR_PROVIDER_ID, inspector, {
    provenance: 'builtin',
    source: 'scripts/baseline_build_readiness.ts',
    reason:
      'canonical compiler-outputs inspection (check_stale_dist + check_dist_workspace_imports)',
  });
  const wrapped = () => {
    dispose();
    if (inspectorDisposers.get(INSPECTOR_PROVIDER_ID) === wrapped) {
      inspectorDisposers.delete(INSPECTOR_PROVIDER_ID);
    }
  };
  inspectorDisposers.set(INSPECTOR_PROVIDER_ID, wrapped);
  return wrapped;
}

export function hasBuildReadinessInspector(): boolean {
  return buildReadinessSeam.getOptional() !== undefined;
}

export function resetBuildReadinessInspector(): void {
  for (const dispose of [...inspectorDisposers.values()]) dispose();
}

/**
 * Run the installed inspector and judge its observations. Never throws:
 * a missing inspector or a throwing scan yields `unknown`, which callers must
 * surface as a stop — never as green.
 */
export async function inspectBuildReadiness(): Promise<BuildReadinessResult> {
  const inspector = buildReadinessSeam.getOptional();
  if (!inspector) {
    return {
      state: 'unknown',
      code: 'inspector_unavailable',
      detail:
        'no build-readiness inspector is installed in this process — run `pnpm run check` or `pnpm build` for a definitive answer',
      findings: [],
      scanFailures: [],
      generation: NO_GENERATION,
    };
  }
  let inspection: BuildReadinessInspection;
  try {
    inspection = await inspector();
  } catch (error) {
    return {
      state: 'unknown',
      code: 'inspection_failed',
      detail: `build-readiness inspection threw: ${error instanceof Error ? error.message : String(error)}`,
      findings: [],
      scanFailures: [],
      generation: NO_GENERATION,
    };
  }
  return judgeBuildReadiness(inspection);
}
