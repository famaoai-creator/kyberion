/** Explicit, review-only entry for making completed work reusable. */
import {
  prepareReusableLearning,
  queueReusableLearning,
  type LearningDestination,
} from '@agent/core/knowledge/reusable-learning';
import { currentScope } from '@agent/core/scope-context';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync } from '@agent/core/secure-io';
import { defineScript, isDirectScript } from './lib/harness.js';
import { parseGuardedCliArgs, type CliGuardSpec } from './lib/cli-guard.js';
import type { MemoryScopeEnvelope } from '@agent/core/knowledge/memory-scope';

export const LEARNING_PREPARE_CLI: CliGuardSpec = {
  command: 'pnpm kyberion learning prepare',
  manifestId: 'script.learning.prepare',
  options: [
    { flag: '--input', value: '<material-file>' },
    { flag: '--run', value: '<run-adf-file>' },
    { flag: '--mission', value: '<mission-id>' },
    { flag: '--intent', value: '<reusable-purpose>' },
    { flag: '--title', value: '<title>' },
    { flag: '--destination', value: '<knowledge|skill|pipeline|procedure|evidence>' },
    { flag: '--reuse-when', value: '<reuse-condition>' },
    { flag: '--verify', value: '<verification-command>' },
    { flag: '--replace-target', value: '<existing-asset>' },
    { flag: '--queue' },
    { flag: '--candidate', value: '<learning-candidate-id>' },
    { flag: '--dry-run' },
    { flag: '--json' },
  ],
};

function value(options: Record<string, string | boolean>, name: string): string | undefined {
  return typeof options[name] === 'string' ? (options[name] as string) : undefined;
}

export function resolveLearningSource(
  options: Record<string, string | boolean>,
  selected: MemoryScopeEnvelope
): { sourceRef: string; scope: MemoryScopeEnvelope; destination?: LearningDestination } {
  const input = value(options, '--input');
  const run = value(options, '--run');
  const mission = value(options, '--mission');
  if ([input, run, mission].filter(Boolean).length !== 1)
    throw new Error('[LEARNING_INTAKE_INVALID] Select exactly one of --input, --run or --mission');
  if (!mission)
    return {
      sourceRef: input || run!,
      scope: selected,
      ...(run ? { destination: 'pipeline' } : {}),
    };
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/u.test(mission))
    throw new Error('[LEARNING_SOURCE_SCOPE] Invalid mission id');
  if (selected.mission_id && selected.mission_id !== mission)
    throw new Error(
      '[LEARNING_SOURCE_SCOPE] Select the mission execution context before learning from another mission'
    );
  if (selected.tier === 'personal')
    throw new Error(
      '[LEARNING_SOURCE_SCOPE] Personal missions require an owner-scoped material file'
    );
  const partition = selected.tier === 'confidential' ? `${selected.tenant_slug}/` : '';
  const root = `active/missions/${selected.tier}/${partition}${mission}/evidence`;
  const source = ['distillation.md', 'retrospective.md']
    .map((name) => `${root}/${name}`)
    .find((ref) => safeExistsSync(pathResolver.rootResolve(ref)));
  if (!source)
    throw new Error(
      '[LEARNING_SOURCE_INVALID] Mission has no distillation or retrospective evidence; record it before preparing reuse'
    );
  return { sourceRef: source, scope: { ...selected, mission_id: mission } };
}

export const runLearningPrepare = defineScript({
  name: 'learning-prepare',
  flags: ['json', 'dry-run'],
  run: ({ argv, print, dryRun, json }) => {
    const parsed = parseGuardedCliArgs(argv, LEARNING_PREPARE_CLI, print);
    if (parsed.handled) return;
    const options = parsed.options;
    if (options['--queue']) {
      const candidate = value(options, '--candidate');
      if (
        !candidate ||
        ['--input', '--run', '--mission'].some((name) => options[name] !== undefined)
      )
        throw new Error(
          '[LEARNING_INTAKE_INVALID] --queue requires --candidate and no new material source'
        );
      const result = queueReusableLearning(candidate, currentScope(), { dryRun });
      print(
        json
          ? result
          : [
              `${result.queued ? 'Queued for review' : 'Dry run'}: ${result.memory_candidate_id}`,
              ...result.next_steps,
            ].join('\n')
      );
      return;
    }
    if (options['--candidate'])
      throw new Error('[LEARNING_INTAKE_INVALID] --candidate requires --queue');
    const source = resolveLearningSource(options, currentScope());
    const result = prepareReusableLearning(
      {
        ...source,
        intent: value(options, '--intent') || '',
        title: value(options, '--title') || '',
        destination: (value(options, '--destination') ||
          source.destination ||
          'knowledge') as LearningDestination,
        reuseCondition: value(options, '--reuse-when') || '',
        verificationCommand: value(options, '--verify') || '',
        replaceTarget: value(options, '--replace-target'),
      },
      { dryRun }
    );
    if (json) {
      print(result);
      return;
    }
    print(
      [
        `${result.plan.decision}: ${result.plan.destination}`,
        result.plan.reason,
        ...(result.plan.target_ref
          ? [`Target: ${result.plan.target_ref} (${result.plan.base_sha256})`]
          : []),
        ...(result.candidate
          ? [
              `Candidate: ${result.candidate.candidate_id}${result.persisted ? ' (proposed)' : ' (dry run)'}`,
            ]
          : []),
        'Preparing a candidate does not approve or publish it.',
        ...result.plan.next_steps,
      ].join('\n')
    );
  },
});

if (
  isDirectScript(import.meta.url, 'learning_prepare.ts') ||
  isDirectScript(import.meta.url, 'learning_prepare.js')
)
  void runLearningPrepare();
