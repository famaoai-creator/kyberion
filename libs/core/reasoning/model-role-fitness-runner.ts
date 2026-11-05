import { nowIso } from '../foundation/time.js';
import { buildTaskReasoningBackend } from './reasoning-bootstrap.js';
import type { ReasoningBackend, ReasoningCallOptions } from './reasoning-backend-contracts.js';
import { providerIdForReasoningIdentifier } from '../provider/provider-egress-gate.js';
import { resolveModelProvider } from './reasoning-model-routing.js';
import {
  evaluateRoleFitnessResponse,
  listRoleFitnessProbes,
  loadRoleFitnessProbeCatalog,
  recordModelRoleFitness,
  normalizeFitnessProviderId,
  type RoleFitnessEvaluation,
} from './model-role-fitness.js';

/**
 * TC-15: the half of role-fitness measurement that needs a model.
 *
 * Kept apart from `model-role-fitness.ts` on purpose. Scoring, the journal
 * and the selection prior are read on the mission CLI's hot path; the runner
 * pulls in the whole reasoning-backend graph. Splitting them keeps an LLM
 * stack out of every `mission_controller` invocation that only wants to know
 * what a model already scored.
 */
export interface RunModelRoleFitnessProbesResult {
  model_id: string;
  provider?: string;
  team_role?: string;
  status: 'completed' | 'no_probes' | 'backend_unavailable' | 'provider_mismatch';
  detail?: string;
  evaluations: Array<RoleFitnessEvaluation & { recorded: boolean }>;
}

/**
 * Per-probe ceiling. The runner bounds every probe itself and builds its
 * backend with `requestTimeout: 'caller'` and this as `timeoutMs`: through
 * the route's request wrapper (and the default chain's 60s route limit) a
 * slow-but-correct model's probe was cut off and silently dropped, so the
 * measurement depended on the wrapper, not the model.
 */
export const ROLE_FITNESS_PROBE_TIMEOUT_MS = 180_000;

/** The measurement backend: caller-bounded, so no route wrapper answers for the model. */
function buildRoleFitnessBackend(): ReasoningBackend {
  return buildTaskReasoningBackend({
    requestTimeout: 'caller',
    timeoutMs: ROLE_FITNESS_PROBE_TIMEOUT_MS,
  });
}

async function promptWithin(
  backend: ReasoningBackend,
  prompt: string,
  options: ReasoningCallOptions,
  timeoutMs: number
): Promise<string> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`[ROLE_FITNESS_PROBE_TIMEOUT] probe exceeded ${timeoutMs}ms`);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      backend.prompt(prompt, { ...options, signal: controller.signal }),
      timedOut,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runModelRoleFitnessProbes(input: {
  modelId: string;
  provider?: string;
  teamRole?: string;
  /** Evaluate without writing to the journal (dry run). */
  record?: boolean;
  /** Per-probe ceiling (default {@link ROLE_FITNESS_PROBE_TIMEOUT_MS}). */
  probeTimeoutMs?: number;
}): Promise<RunModelRoleFitnessProbesResult> {
  const probes = listRoleFitnessProbes(input.teamRole);
  const base: RunModelRoleFitnessProbesResult = {
    model_id: input.modelId,
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.teamRole ? { team_role: input.teamRole } : {}),
    status: 'no_probes',
    evaluations: [],
  };
  if (probes.length === 0) return base;

  let backend: ReasoningBackend;
  try {
    backend = buildRoleFitnessBackend();
  } catch (error) {
    return {
      ...base,
      status: 'backend_unavailable',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  if (backend.name === 'stub') return { ...base, status: 'backend_unavailable' };

  // A backend that silently ignores the requested model would answer as
  // itself and have the verdict filed under a model that never spoke — and
  // that record then steers real staffing. `options.model` is a request, not
  // a guarantee, and no backend reports back what actually answered, so the
  // only honest check available is that the active backend belongs to the
  // requested model's provider. When it does not, refuse rather than record
  // evidence we cannot stand behind.
  const backendProvider = normalizeFitnessProviderId(
    providerIdForReasoningIdentifier(backend.name) || backend.name
  );
  const modelProvider = normalizeFitnessProviderId(
    input.provider?.trim() || resolveModelProvider(input.modelId)
  );
  if (backendProvider && modelProvider && backendProvider !== modelProvider) {
    return {
      ...base,
      status: 'provider_mismatch',
      detail:
        `The active reasoning backend is ${backend.name} (${backendProvider}), which cannot answer as a ` +
        `${modelProvider} model. Select that provider's backend before measuring ${input.modelId}.`,
    };
  }

  const threshold = loadRoleFitnessProbeCatalog().pass_threshold;
  const evaluations: Array<RoleFitnessEvaluation & { recorded: boolean }> = [];
  for (const probe of probes) {
    let raw = '';
    try {
      raw = await promptWithin(
        backend,
        probe.prompt,
        { model: input.modelId },
        input.probeTimeoutMs ?? ROLE_FITNESS_PROBE_TIMEOUT_MS
      );
    } catch {
      // An unreachable (or timed-out) model is not a failing model: record
      // nothing rather than blame the model for the transport.
      continue;
    }
    const evaluation = evaluateRoleFitnessResponse(probe, raw, threshold);
    const shouldRecord = input.record !== false;
    if (shouldRecord) {
      recordModelRoleFitness({
        model_id: input.modelId,
        ...(input.provider ? { provider: input.provider } : {}),
        team_role: probe.team_role,
        probe_id: probe.id,
        score: evaluation.score,
        passed: evaluation.passed,
        backend: backend.name,
        evaluated_at: nowIso(),
        failed_assertions: evaluation.assertions
          .filter((entry) => !entry.passed)
          .map((entry) => `${entry.kind}${entry.detail ? `: ${entry.detail}` : ''}`),
      });
    }
    evaluations.push({ ...evaluation, recorded: shouldRecord });
  }

  return { ...base, status: 'completed', evaluations };
}
