import { logger } from './core.js';
import { getReasoningBackend } from './reasoning-backend.js';
import { tryRepairJson } from './json-repair.js';
import { persistHints, readHintsByCategory } from './src/feedback-loop.js';
import { safeExistsSync, safeReadFile, safeWriteFile } from './secure-io.js';
import { sendOpsAlert } from './ops-alert.js';

/**
 * AR-01 Task 4: single autonomous-repair implementation shared by every
 * runner (run_pipeline, super-nerve). Previously each carried its own copy
 * and only run_pipeline enforced the AO-03 §4 sensitive-path guardrail —
 * super-nerve would happily dispatch a repair subagent for .env/auth/config
 * failures. Centralizing here closes that gap for all callers.
 */

export interface RepairFailure {
  category: string;
  detail?: string;
  label?: string;
  repairAction?: string;
}

export interface RepairStepRef {
  op: string;
  id?: string;
  params?: unknown;
}

export interface RepairPolicy {
  effort?: unknown;
  budget?: unknown;
}

export interface AutonomousRepairRequest {
  step: RepairStepRef;
  failure: RepairFailure;
  /** When set, the repair targets this pipeline ADF file. */
  pipelinePath?: string;
  policy?: RepairPolicy;
  /**
   * Post-repair verification (e.g. re-validate the ADF). A throw means the
   * repair did not actually leave the target in a valid state → false.
   */
  validate?: () => Promise<unknown>;
  /** Log prefix, e.g. '[SYS_PIPELINE:REPAIR]' or '[NERVE:REPAIR]'. */
  logPrefix?: string;
}

// Repairs that would touch .env / authority / config / secrets MUST NOT run
// without operator approval (AO-03 §4, SA-02). Unattended runs have no
// approval channel, so we fail closed and escalate.
const SENSITIVE_CATEGORIES = ['permission_error', 'auth_error', 'config_error', 'env_error'];

/**
 * LC-01: cheap structural repair of a broken ADF file. Returns true only when
 * the file did not parse, a normalization candidate does, and the caller's
 * post-repair validation (schema + guardrails) passes on the rewritten file.
 * A parseable-but-invalid file is left for the LLM path.
 */
async function tryDeterministicAdfRepair(
  pipelinePath: string,
  validate: (() => Promise<unknown>) | undefined,
  prefix: string
): Promise<boolean> {
  try {
    if (!safeExistsSync(pipelinePath)) return false;
    const raw = String(safeReadFile(pipelinePath, { encoding: 'utf8' }));
    try {
      JSON.parse(raw);
      return false; // structurally fine — the failure is semantic, LLM territory
    } catch {
      // fall through to repair
    }
    const repaired = tryRepairJson(raw);
    if (repaired === null) return false;
    safeWriteFile(pipelinePath, `${JSON.stringify(repaired, null, 2)}\n`);
    if (validate) await validate();
    logger.info(`  ${prefix} Deterministic JSON repair fixed ${pipelinePath} (no LLM call).`);
    return true;
  } catch {
    // Repaired JSON still fails validation (or IO failed) — keep the
    // parseable rewrite if it landed and let the LLM path continue.
    return false;
  }
}

export async function attemptAutonomousRepair(request: AutonomousRepairRequest): Promise<boolean> {
  const { step, failure, pipelinePath, policy, validate } = request;
  const prefix = request.logPrefix || '[REPAIR]';
  try {
    if (SENSITIVE_CATEGORIES.includes(failure.category)) {
      logger.warn(
        `  ${prefix} Repair category "${failure.category}" involves .env/auth/config changes ` +
          `— autonomous mutation of sensitive paths is prohibited (AO-03 §4). Escalating to operator.`
      );
      sendOpsAlert({
        severity: 'critical',
        title: `Pipeline repair blocked: ${step.op}`,
        context: {
          step_op: step.op,
          error_category: failure.category,
          error_detail: failure.detail ?? '',
          ...(pipelinePath ? { pipeline_path: pipelinePath } : {}),
        },
        recommendation:
          'Manual operator intervention required. Review the error, update .env / authority roles as appropriate, then re-run the pipeline.',
        dedupe_key: `pipeline-repair-blocked:${step.op}:${failure.category}`,
      });
      return false;
    }

    // LC-01: deterministic-first cascade. Mechanical JSON breakage (trailing
    // commas, unclosed brackets, BOM…) needs no tokens and works even with a
    // stub backend — only escalate to the LLM when structure survives parsing
    // but semantics are wrong.
    if (pipelinePath && (await tryDeterministicAdfRepair(pipelinePath, validate, prefix))) {
      return true;
    }

    const backend = getReasoningBackend();
    const repairHint =
      failure.repairAction ||
      'Investigate the error and the pipeline ADF structure to identify a potential fix.';
    // LC-03: inject lessons from earlier repairs of the same failure class so
    // the subagent starts from what worked last time instead of rediscovering.
    const priorRepairs = readHintsByCategory('adf-repair')
      .filter((hint) => hint.topic.startsWith(`repair:${failure.category}:`))
      .slice(-3);
    const priorRepairsBlock =
      priorRepairs.length > 0
        ? `\nEarlier repairs of the same failure class (reuse the pattern when it applies):\n${priorRepairs
            .map((hint) => `- ${hint.hint}`)
            .join('\n')}`
        : '';
    const fixTarget = pipelinePath
      ? `FIX the pipeline ADF structure at ${pipelinePath} if it is a structural or parameter error.`
      : 'FIX the failing step definition or the repository state it depends on, if the error is structural.';

    const instruction = `
The following pipeline step failed in Kyberion:
Step Operation: ${step.op}
Step Params: ${JSON.stringify(step.params ?? {})}
Error Category: ${failure.category}
Error Detail: ${failure.detail ?? ''}

Repair Hint: ${repairHint}${priorRepairsBlock}
${policy ? `Step Policy: ${JSON.stringify(policy)}` : ''}

Repair Action Goal:
1. ANALYZE the error and parameters.
2. ${fixTarget}
3. DO NOT modify .env files, authority roles, config secrets, or any file outside the pipeline ADF.
   If the error requires such changes, output a description of what needs to be changed but do NOT apply it.
4. Ensure the resulting ADF follows the required schema.

Assume the persona of a "Sovereign System Recovery Agent".
Once finished, provide a brief summary of the changes you applied to fix the pipeline.
`.trim();

    // Snapshot before the subagent runs so we can tell whether it actually
    // changed anything — a subagent that (correctly) declines to touch a
    // security-gated file still returns a report, and re-validating an
    // untouched file trivially passes, which previously got reported as a
    // successful repair regardless of what the subagent's own verdict said
    // (found via live loop simulation: a subagent explicitly halted with
    // "CHANGES APPLIED: None" on a tier-isolation violation, yet the caller
    // logged "Repair successful" and retried the step anyway).
    const beforeContent =
      pipelinePath && safeExistsSync(pipelinePath)
        ? String(safeReadFile(pipelinePath, { encoding: 'utf8' }))
        : undefined;

    const report = await backend.delegateTask(
      instruction,
      `Self-Healing Mission for ${step.op}`,
      policy ? ({ effort: policy.effort, budget: policy.budget } as any) : undefined
    );
    logger.info(`  ${prefix} Sub-agent report: ${report}`);

    if (pipelinePath && beforeContent !== undefined) {
      const afterContent = safeExistsSync(pipelinePath)
        ? String(safeReadFile(pipelinePath, { encoding: 'utf8' }))
        : undefined;
      if (afterContent === beforeContent) {
        logger.warn(
          `  ${prefix} Sub-agent made no change to ${pipelinePath} — treating as an unresolved failure, not a successful repair.`
        );
        return false;
      }
    }

    if (validate) {
      try {
        await validate();
      } catch (validationErr: any) {
        logger.warn(
          `  ${prefix} Sub-agent finished but the repair target is still invalid: ${validationErr.message}`
        );
        return false;
      }
    }
    // LC-03: a validated repair is a lesson — persist failure class → pattern
    // so the next same-class failure starts from it (dedup by topic).
    try {
      persistHints(
        [
          {
            topic: `repair:${failure.category}:${step.op}`,
            hint: `${step.op} failed with ${failure.category}${
              failure.detail ? ` (${String(failure.detail).slice(0, 160)})` : ''
            } — repaired: ${String(report).slice(0, 240)}`,
            source: pipelinePath || step.op,
            confidence: 0.7,
            tags: ['adf-repair', failure.category],
          },
        ],
        'adf-repair'
      );
    } catch {
      // Learning is additive; never fail a successful repair over it.
    }
    return true;
  } catch (err: any) {
    logger.error(`  ${prefix} Failed to perform repair: ${err.message}`);
    return false;
  }
}
