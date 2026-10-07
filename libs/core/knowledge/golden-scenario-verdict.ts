/**
 * Golden-scenario verdicts: did a procedure run actually succeed?
 *
 * Each promoted procedure carries a golden scenario — success conditions
 * captured when its recording was compiled. This module stores it next to
 * the catalog the procedure was promoted into, and after a run compares the
 * run's own evidence against it:
 *
 * - `pass` — every checkable condition was met and at least one of them is a
 *   strong condition (it names what must be produced or shown).
 * - `fail` — a checkable condition was not met.
 * - `inconclusive` — nothing strong could be checked: the evidence does not
 *   cover the condition kinds (e.g. a screenshot comparison), or the only
 *   conditions are weak fallbacks the compiler adds when it found no anchor.
 *
 * A false pass is the dangerous outcome, so anything short of evidence is
 * `inconclusive`, never `pass`. The check runs after the run on what the run
 * returned; it never re-executes anything.
 *
 * Verdicts feed the knowledge-verification ledger as `golden` evidence for the
 * procedure's recording (or pipeline), so a later change to that file shows as
 * "changed since it last passed", and a failed check as a problem.
 */

import * as path from 'node:path';
import { defineCatalog } from '../foundation/governed-catalog.js';
import { logger } from '../core.js';
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
import type { ServiceStepResult } from '../service/service-procedure-executor.js';
import type { GoldenScenario, GoldenSuccessCondition, ProcedureEntry } from './procedure-types.js';
import { recordKnowledgeProblem, recordKnowledgeVerifiedRun } from './knowledge-verification.js';

const GOLDEN_SCHEMA_PATH = pathResolver.knowledge('product/schemas/golden-scenario.schema.json');
const goldenValidator = defineCatalog<GoldenScenario>({
  id: 'golden-scenario',
  path: 'golden scenario',
  schema: GOLDEN_SCHEMA_PATH,
});

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/**
 * Where a procedure's golden scenario lives: a `golden/` directory next to the
 * catalog it was promoted into, so it shares the catalog's tier.
 */
export function goldenScenarioPathForCatalog(
  catalogPath: string,
  procedureId: string,
  version: string
): string {
  const safeId = procedureId.replace(/[^A-Za-z0-9._-]/g, '_');
  const safeVersion = version.replace(/[^0-9A-Za-z.-]/g, '_');
  return assertSafeRepositoryPath(
    path.join(path.dirname(catalogPath), 'golden', `${safeId}.v${safeVersion}.json`),
    { allowMissingLeaf: true }
  );
}

/** Validate and write a golden scenario; returns its repo-relative ref. */
export function saveGoldenScenario(scenario: GoldenScenario, filePath: string): string {
  const validated = goldenValidator.validate(scenario, filePath);
  const safePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
  safeMkdir(path.dirname(safePath), { recursive: true });
  safeWriteFile(safePath, `${JSON.stringify(validated, null, 2)}\n`);
  return pathResolver.toRepoRelative(safePath);
}

/** Load a procedure's golden scenario, or undefined when it has none or it is unreadable. */
export function loadGoldenScenario(procedure: ProcedureEntry): GoldenScenario | undefined {
  const ref = procedure.golden_scenario_ref?.trim();
  if (!ref) return undefined;
  try {
    const filePath = assertSafeRepositoryPath(pathResolver.rootResolve(ref));
    if (!safeExistsSync(filePath) || !safeLstat(filePath).isFile()) return undefined;
    const scenario = goldenValidator.validate(readJsonIfPresent<unknown>(filePath), ref);
    return scenario.procedure_id === procedure.procedure_id ? scenario : undefined;
  } catch (error) {
    logger.warn(
      `[golden-scenario] golden scenario unreadable for ${procedure.procedure_id} — ${
        error instanceof Error ? error.message : String(error)
      } | next: re-promote the procedure or fix ${ref}`
    );
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

/** One element of the page as the run left it (from a browser snapshot). */
export interface RunEvidenceElement {
  role?: string | null;
  name?: string | null;
  text?: string | null;
  visible?: boolean;
}

/** What a run returned, normalised across substrates. */
export interface RunEvidence {
  substrate: string;
  /** service:preset per-step results. */
  serviceResults?: ServiceStepResult[];
  /**
   * Channels whose value is non-empty after the run (names only, never the
   * values). A step that returned nothing still reports `produced`, so this
   * is what tells a real response from an empty one.
   */
  serviceChannelsPresent?: string[];
  /** Elements of the last page snapshot (browser substrates). */
  snapshotElements?: RunEvidenceElement[];
}

/** Names of service channels that hold a non-empty value (values are not kept). */
export function presentServiceChannels(channels: Record<string, unknown> | undefined): string[] {
  if (!channels) return [];
  return Object.entries(channels)
    .filter(([, value]) => {
      if (value === undefined || value === null) return false;
      if (typeof value === 'string') return value.trim().length > 0;
      if (Array.isArray(value)) return value.length > 0;
      if (typeof value === 'object') return Object.keys(value as object).length > 0;
      return true;
    })
    .map(([name]) => name);
}

/**
 * Context key the post-run snapshot is exported under. A dedicated key (not
 * `last_snapshot`) guarantees the check reads the page as the run left it,
 * never a snapshot some earlier step took before the final action.
 */
export const GOLDEN_FINAL_SNAPSHOT_KEY = 'golden_final_snapshot';

/** Whether a scenario has conditions only a post-run page snapshot can check. */
export function needsFinalPageSnapshot(scenario: GoldenScenario | undefined): boolean {
  return Boolean(
    scenario?.success_conditions.some(
      (condition) => condition.kind === 'ref_visible' || condition.kind === 'text_present'
    )
  );
}

/** Read-only step appended to a browser run so the check sees the final page. */
export function finalPageSnapshotStep(): {
  id: string;
  type: string;
  op: string;
  params: Record<string, unknown>;
} {
  return {
    id: 'golden-final-snapshot',
    type: 'capture',
    op: 'snapshot',
    params: { export_as: GOLDEN_FINAL_SNAPSHOT_KEY },
  };
}

/** Pull the post-run snapshot's elements out of a browser-actuator run context. */
export function snapshotElementsFromBrowserContext(
  context: unknown
): RunEvidenceElement[] | undefined {
  if (!context || typeof context !== 'object') return undefined;
  const snapshot = (context as Record<string, unknown>)[GOLDEN_FINAL_SNAPSHOT_KEY];
  if (!snapshot || typeof snapshot !== 'object') return undefined;
  const elements = (snapshot as Record<string, unknown>).elements;
  if (!Array.isArray(elements)) return undefined;
  return elements
    .filter((element): element is Record<string, unknown> =>
      Boolean(element && typeof element === 'object')
    )
    .map((element) => ({
      role: typeof element.role === 'string' ? element.role : null,
      name: typeof element.name === 'string' ? element.name : null,
      text: typeof element.text === 'string' ? element.text : null,
      visible: element.visible !== false,
    }));
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

export type GoldenConditionOutcome = 'met' | 'unmet' | 'unsupported';

export interface GoldenConditionResult {
  index: number;
  kind: GoldenSuccessCondition['kind'];
  outcome: GoldenConditionOutcome;
  /** Weak conditions (compiler fallbacks) alone never make a pass. */
  strength: 'strong' | 'weak';
  detail: string;
}

export interface GoldenVerdict {
  scenario_id: string;
  procedure_id: string;
  verdict: 'pass' | 'fail' | 'inconclusive';
  conditions: GoldenConditionResult[];
}

const lower = (value: unknown) => (typeof value === 'string' ? value.toLowerCase() : '');

/** Anchors the compilers set on fallback conditions when they found no real one. */
const FALLBACK_ANCHORS = new Set(['last_action_target', 'last_service_result']);

/**
 * Whether a condition names what must be produced or shown. Only a met strong
 * condition can pass a run; the compilers' fallbacks ("the control just used
 * is still visible", "the last service step finished") are weak.
 */
export function goldenConditionStrength(condition: GoldenSuccessCondition): 'strong' | 'weak' {
  if (FALLBACK_ANCHORS.has(String(condition.params?.anchor ?? ''))) return 'weak';
  if (condition.kind === 'ref_visible' || condition.kind === 'text_present') {
    return condition.name_contains ? 'strong' : 'weak';
  }
  if (condition.kind === 'response_field') {
    return typeof condition.params?.channel === 'string' ? 'strong' : 'weak';
  }
  return 'weak';
}

function matchesElement(
  element: RunEvidenceElement,
  condition: GoldenSuccessCondition,
  field: 'name' | 'text'
): boolean {
  if (condition.role && lower(element.role) !== lower(condition.role)) return false;
  if (!condition.name_contains) return true;
  const needle = condition.name_contains.toLowerCase();
  const haystacks = field === 'name' ? [element.name, element.text] : [element.text, element.name];
  return haystacks.some((value) => lower(value).includes(needle));
}

function evaluateCondition(
  condition: GoldenSuccessCondition,
  index: number,
  evidence: RunEvidence
): GoldenConditionResult {
  const base = { index, kind: condition.kind };
  const params = condition.params ?? {};
  switch (condition.kind) {
    case 'response_field': {
      const results = evidence.serviceResults;
      if (!results) {
        return {
          ...base,
          outcome: 'unsupported',
          strength: 'strong',
          detail: 'no service results',
        };
      }
      if (params.anchor === 'last_service_result') {
        const last = results[results.length - 1];
        return {
          ...base,
          strength: 'weak',
          outcome: last?.status === 'done' ? 'met' : 'unmet',
          detail: last ? `last step ${last.step_id} ${last.status}` : 'no steps ran',
        };
      }
      const channel = typeof params.channel === 'string' ? params.channel : undefined;
      if (!channel) {
        return { ...base, outcome: 'unsupported', strength: 'weak', detail: 'no channel named' };
      }
      const producer = results.find(
        (result) =>
          result.produced === channel &&
          (!params.service_id || result.service_id === params.service_id) &&
          (!params.action || result.action === params.action)
      );
      const empty =
        producer?.status === 'done' &&
        evidence.serviceChannelsPresent !== undefined &&
        !evidence.serviceChannelsPresent.includes(channel);
      return {
        ...base,
        strength: 'strong',
        outcome: producer?.status === 'done' && !empty ? 'met' : 'unmet',
        detail: !producer
          ? `nothing produced ${channel}`
          : empty
            ? `${channel} from step ${producer.step_id} came back empty`
            : `${channel} from step ${producer.step_id}: ${producer.status}`,
      };
    }
    case 'ref_visible':
    case 'text_present': {
      const elements = evidence.snapshotElements;
      if (!elements) {
        return { ...base, outcome: 'unsupported', strength: 'strong', detail: 'no page snapshot' };
      }
      const strength = goldenConditionStrength(condition);
      const found = elements.some(
        (element) =>
          (condition.kind === 'text_present' || element.visible !== false) &&
          matchesElement(element, condition, condition.kind === 'ref_visible' ? 'name' : 'text')
      );
      const target = [condition.role, condition.name_contains].filter(Boolean).join(' ');
      return {
        ...base,
        strength,
        outcome: found ? 'met' : 'unmet',
        detail: `${condition.kind === 'ref_visible' ? 'visible' : 'text'} "${target}" ${found ? 'found' : 'not found'}`,
      };
    }
    default:
      // screenshot_state / file_generated / theme_applied / structure_match
      // need evidence this check does not collect yet.
      return {
        ...base,
        outcome: 'unsupported',
        strength: 'weak',
        detail: `${condition.kind} is not checked from run evidence`,
      };
  }
}

/** Compare a run's evidence with a golden scenario. Pure; never throws for bad evidence. */
export function evaluateGoldenScenario(
  scenario: GoldenScenario,
  evidence: RunEvidence
): GoldenVerdict {
  const conditions = scenario.success_conditions.map((condition, index) =>
    evaluateCondition(condition, index, evidence)
  );
  const verdict = conditions.some((result) => result.outcome === 'unmet')
    ? 'fail'
    : conditions.some((result) => result.outcome === 'met' && result.strength === 'strong')
      ? 'pass'
      : 'inconclusive';
  return {
    scenario_id: scenario.scenario_id,
    procedure_id: scenario.procedure_id,
    verdict,
    conditions,
  };
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

/**
 * The file whose text defines the procedure's behaviour: its recording, or
 * its pipeline when it has no recording. Its fingerprint versions verdicts.
 */
export function procedureVerificationDocument(procedure: ProcedureEntry): string | undefined {
  return procedure.adapter.recording_ref?.trim() || procedure.pipeline_ref?.trim() || undefined;
}

/**
 * Check a finished run against the procedure's golden scenario and record the
 * verdict. Returns undefined when the procedure has no golden scenario. Fails
 * open: a broken check never changes the run's own result.
 */
export function verifyProcedureRun(input: {
  procedure: ProcedureEntry;
  evidence: RunEvidence;
  scope?: ScopeContext;
}): GoldenVerdict | undefined {
  try {
    const scenario = loadGoldenScenario(input.procedure);
    if (!scenario) return undefined;
    const verdict = evaluateGoldenScenario(scenario, input.evidence);
    const documentPath = procedureVerificationDocument(input.procedure);
    if (documentPath && verdict.verdict === 'pass') {
      recordKnowledgeVerifiedRun({
        documentPaths: [documentPath],
        evidence: 'golden',
        ...(input.scope ? { scope: input.scope } : {}),
      });
    } else if (documentPath && verdict.verdict === 'fail') {
      const unmet = verdict.conditions.find((result) => result.outcome === 'unmet');
      recordKnowledgeProblem({
        documentPath,
        kind: 'failed_check',
        ...(unmet ? { reason: `${unmet.kind}: ${unmet.detail}` } : {}),
        ...(input.scope ? { scope: input.scope } : {}),
      });
    }
    return verdict;
  } catch (error) {
    logger.warn(
      `[golden-scenario] verdict not recorded for ${input.procedure.procedure_id} — ${
        error instanceof Error ? error.message : String(error)
      } | next: check the golden scenario and feedback-loop runtime directory`
    );
    return undefined;
  }
}
