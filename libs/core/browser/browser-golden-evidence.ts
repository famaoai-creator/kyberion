/**
 * Golden-scenario verdicts for runs the Chrome extension executed
 * (`extension_session` substrate).
 *
 * The dispatcher only issues a lease for these runs; the extension acts on the
 * page and reports back. After a completed run it sends the page evidence the
 * procedure's success conditions need — only elements that match a condition,
 * never the whole page — and the host judges it with the same evaluator the
 * Playwright and service substrates use (`golden-scenario-verdict.ts`). The
 * extension never decides pass/fail itself.
 *
 * The evidence must belong to a run the host already knows about: a persisted
 * `completed` receipt for the procedure's recording and the same lease. Each
 * receipt is judged once, so evidence cannot be resubmitted to flip a verdict.
 */

import * as path from 'node:path';
import { pathResolver } from '../path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeWriteFile,
} from '../secure-io.js';
import { readJsonIfPresent } from '../foundation/json.js';
import type { ScopeContext } from '../scope-context.js';
import {
  loadGoldenScenario,
  verifyProcedureRun,
  type GoldenVerdict,
  type RunEvidenceElement,
} from '../knowledge/golden-scenario-verdict.js';
import type { ProcedureEntry } from '../knowledge/procedure-types.js';
import { validateBrowserExtensionReceipt } from './browser-extension-bridge.js';

const RECEIPT_STORE = pathResolver.shared('runtime/browser-receipts');
const MAX_ELEMENTS = 200;
const MAX_TEXT = 300;

function receiptFileStem(receiptId: string): string | undefined {
  const stem = String(receiptId || '')
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return stem || undefined;
}

function clip(value: unknown): string | null {
  return typeof value === 'string' ? value.slice(0, MAX_TEXT) : null;
}

/** Bound and type-check the element list the extension sent. */
export function normalizeExtensionGoldenElements(raw: unknown): RunEvidenceElement[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw
    .filter((element): element is Record<string, unknown> =>
      Boolean(element && typeof element === 'object')
    )
    .slice(0, MAX_ELEMENTS)
    .map((element) => ({
      role: clip(element.role),
      name: clip(element.name),
      text: clip(element.text),
      visible: element.visible !== false,
    }));
}

export type ExtensionGoldenJudgement =
  { ok: true; verdict: GoldenVerdict | null } | { ok: false; error: string };

/**
 * Judge an extension run against the procedure's golden scenario and record
 * the verdict. `verdict: null` means the procedure has no golden scenario.
 */
export function judgeExtensionRun(input: {
  procedure: ProcedureEntry;
  recordingId: string;
  receiptId: unknown;
  elements: unknown;
  scope?: ScopeContext;
}): ExtensionGoldenJudgement {
  const stem = typeof input.receiptId === 'string' ? receiptFileStem(input.receiptId) : undefined;
  if (!stem) return { ok: false, error: 'golden evidence requires receipt_id' };
  const elements = normalizeExtensionGoldenElements(input.elements);
  if (!elements) return { ok: false, error: 'golden evidence requires an elements array' };

  const receiptPath = assertSafeRepositoryPath(path.join(RECEIPT_STORE, `${stem}.json`), {
    allowMissingLeaf: true,
  });
  if (!safeExistsSync(receiptPath) || !safeLstat(receiptPath).isFile()) {
    return { ok: false, error: 'no recorded receipt for this run' };
  }
  const receipt = validateBrowserExtensionReceipt(readJsonIfPresent<unknown>(receiptPath)).value;
  if (!receipt) return { ok: false, error: 'recorded receipt is invalid' };
  if (receipt.status !== 'completed') {
    return { ok: false, error: `run did not complete (receipt status ${receipt.status})` };
  }
  if (receipt.recording_id !== input.recordingId || !receipt.lease_id) {
    return { ok: false, error: 'receipt does not belong to this procedure run' };
  }

  if (!loadGoldenScenario(input.procedure)) return { ok: true, verdict: null };

  const markerPath = assertSafeRepositoryPath(path.join(RECEIPT_STORE, `${stem}.golden.json`), {
    allowMissingLeaf: true,
  });
  if (safeExistsSync(markerPath)) {
    return { ok: false, error: 'this run has already been judged' };
  }
  const verdict =
    verifyProcedureRun({
      procedure: input.procedure,
      evidence: { substrate: 'extension_session', snapshotElements: elements },
      ...(input.scope ? { scope: input.scope } : {}),
    }) ?? null;
  safeMkdir(RECEIPT_STORE, { recursive: true });
  safeWriteFile(
    markerPath,
    `${JSON.stringify(
      {
        receipt_id: receipt.receipt_id,
        procedure_id: input.procedure.procedure_id,
        verdict: verdict?.verdict ?? 'not_recorded',
        judged_at: new Date().toISOString(),
      },
      null,
      2
    )}\n`
  );
  return { ok: true, verdict };
}
