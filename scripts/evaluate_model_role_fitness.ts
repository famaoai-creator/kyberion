import { runModelRoleFitnessProbes } from '@agent/core/model-role-fitness-runner';
import { listRoleFitnessProbes, resolveModelRoleFitness } from '@agent/core/model-role-fitness';
import { installReasoningBackends } from '@agent/core/reasoning-bootstrap';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

/**
 * TC-15: ask a model whether it can hold a team role, before a mission does.
 *
 * New providers and models arrive continuously. Until now the only way one
 * earned a role score was to be trusted with real mission work first and be
 * measured afterwards, which is the wrong order for exactly the models we
 * know least about. This runs the governed probes for a model and records the
 * verdict, so selection has something to go on during that cold start.
 */
export const runEvaluateModelRoleFitness = defineScript({
  name: 'evaluate:model-role-fitness',
  flags: ['dry-run'],
  async run(context) {
    const argv = context.argv;
    const value = (flag: string): string | undefined => {
      const index = argv.indexOf(flag);
      return index >= 0 ? argv[index + 1] : undefined;
    };
    const modelId = value('--model');
    if (!modelId) {
      throw new ScriptExitError(
        1,
        'Usage: evaluate_model_role_fitness --model <MODEL_ID> [--provider <ID>] [--role <TEAM_ROLE>] [--dry-run]'
      );
    }
    // A standalone entrypoint has to install the failover chain itself; the
    // mission CLI does this during its own bootstrap.
    installReasoningBackends();
    const teamRole = value('--role');
    const provider = value('--provider');
    const dryRun = argv.includes('--dry-run');

    if (listRoleFitnessProbes(teamRole).length === 0) {
      throw new ScriptExitError(
        1,
        `No governed fitness probe exists for ${teamRole ? `role ${teamRole}` : 'any role'}.`
      );
    }

    const result = await runModelRoleFitnessProbes({
      modelId,
      ...(provider ? { provider } : {}),
      ...(teamRole ? { teamRole } : {}),
      record: !dryRun,
    });

    if (result.status === 'provider_mismatch') {
      throw new ScriptExitError(1, result.detail || 'Active backend cannot answer as this model.');
    }
    if (result.status === 'backend_unavailable') {
      throw new ScriptExitError(
        1,
        'No reasoning backend is installed; a stub answer is not a fitness measurement.'
      );
    }

    for (const evaluation of result.evaluations) {
      const failed = evaluation.assertions
        .filter((assertion) => !assertion.passed)
        .map(
          (assertion) =>
            `${assertion.required ? '*' : ''}${assertion.kind}${assertion.detail ? ` (${assertion.detail})` : ''}`
        );
      context.print(
        `${evaluation.passed ? 'PASS' : 'FAIL'} ${evaluation.team_role.padEnd(14)} ` +
          `${evaluation.probe_id.padEnd(32)} score=${evaluation.score.toFixed(2)}` +
          (failed.length > 0 ? `  failed: ${failed.join(', ')}` : '')
      );
    }

    const roles = [...new Set(result.evaluations.map((evaluation) => evaluation.team_role))];
    for (const role of roles) {
      const fitness = resolveModelRoleFitness(modelId, role);
      context.print(
        `[fitness] ${modelId} / ${role}: ${fitness.status} score=${fitness.score.toFixed(2)} probes=${fitness.probes}` +
          (dryRun ? ' (dry run — nothing recorded)' : '')
      );
    }
    return result;
  },
});

if (
  isDirectScript(import.meta.url, 'evaluate_model_role_fitness.ts') ||
  isDirectScript(import.meta.url, 'evaluate_model_role_fitness.js')
)
  void runEvaluateModelRoleFitness();
