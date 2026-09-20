import { nowIso } from './foundation/time.js';
import { getReasoningBackend } from './reasoning-backend.js';
import { providerIdForReasoningIdentifier } from './provider-egress-gate.js';
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

export async function runModelRoleFitnessProbes(input: {
  modelId: string;
  provider?: string;
  teamRole?: string;
  /** Evaluate without writing to the journal (dry run). */
  record?: boolean;
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

  const backend = getReasoningBackend();
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
      raw = await backend.prompt(probe.prompt, { model: input.modelId });
    } catch {
      // An unreachable model is not a failing model: record nothing rather
      // than blame the model for the transport.
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
