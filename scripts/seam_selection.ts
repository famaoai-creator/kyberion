#!/usr/bin/env node
/**
 * Seam provider selection — inspect, calibrate and set operator rules.
 *
 *   pnpm kyberion seam select list
 *   pnpm kyberion seam select explain --seam ocr-provider --purpose accuracy [--context language=ja] [--eligible a,b]
 *   pnpm kyberion seam select calibrate --seam ocr-provider --input input.json [--providers a,b] [--repeats 3]
 *   pnpm kyberion seam select rules list [--seam S]
 *   pnpm kyberion seam select rules set --seam S --rule-id R [--purpose P] [--context k=v,...] --prefer a,b [--evidence path] [--note text]
 *   pnpm kyberion seam select rules remove --rule-id R
 *   pnpm kyberion seam select apply-measurements --report <report.json> [--traits t1,t2] [--providers a,b]
 *   pnpm kyberion seam select defaults list [--seam S] [--tenant T] [--organization O] [--project P]
 *   pnpm kyberion seam select defaults set --seam S --provider P [--layer operator|tenant|organization|project] [--tenant T] [--organization O] [--project P] [--note text]
 *   pnpm kyberion seam select defaults unset --seam S [--layer ...] [--tenant T] [--organization O] [--project P]
 *
 * Saved defaults (seam-selection-defaults.ts) apply when a call names no
 * provider and no purpose: env KYBERION_SEAM_DEFAULTS > project >
 * organization > tenant > operator > policy default. The operator layer lives
 * beside the rules; tenant/organization/project layers live in the tenant's
 * partition under active/shared/runtime/seam-selection-defaults/.
 *
 * Rules and measured traits are written to the operator overlay
 * (active/shared/runtime/seam-selection/rules.json) under the
 * sovereign_concierge identity; every change is audited.
 */

import { createStandardYargs } from '@agent/core/cli-utils';
import { withExecutionContextAsync } from '@agent/core/authority';
import { pathResolver } from '@agent/core/path-resolver';
import { assertSafeRepositoryPath } from '@agent/core/secure-io';
import {
  explainSeamProviderDecision,
  getSeamSelectionPolicy,
  seamPolicyDefaultChain,
  listSeamSelectionPolicies,
  type SeamProviderCandidate,
} from '@agent/core/seam-provider-selection';
import {
  listSavedSeamDefaultLayers,
  readSeamDefaultLayer,
  seamDefaultsOperatorPath,
  seamDefaultsScopePath,
  setSeamDefault,
  unsetSeamDefault,
  type SeamDefaultSavedLayer,
  type SeamDefaultScope,
  type SeamDefaultTarget,
} from '@agent/core/seam-selection-defaults';
import {
  listSeamSelectionRules,
  removeSeamSelectionRule,
  seamSelectionRulesPath,
  setSeamSelectionRule,
  setSeamTraitOverrides,
} from '@agent/core/seam-selection-rules';
import {
  getSeamCalibrationAdapter,
  listSeamCalibrationAdapters,
  runSeamCalibration,
  type SeamCalibrationReport,
} from '@agent/core/seam-calibration';
import { readSafeJsonFile } from './lib/json-input.js';
import { registerSeamCalibrationAdapters } from './lib/seam-calibration-adapters.js';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

const OPERATOR_ROLE = 'sovereign_concierge';

function csv(value: unknown): string[] {
  return typeof value === 'string'
    ? value
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean)
    : [];
}

function parseContext(value: unknown): Record<string, string> {
  const context: Record<string, string> = {};
  for (const pair of csv(value)) {
    const index = pair.indexOf('=');
    if (index <= 0)
      throw new ScriptExitError(1, `--context expects key=value pairs, got '${pair}'`);
    context[pair.slice(0, index).trim()] = pair.slice(index + 1).trim();
  }
  return context;
}

function requireSeam(seam: unknown): string {
  const id = typeof seam === 'string' ? seam.trim() : '';
  if (!id || !getSeamSelectionPolicy(id)) {
    throw new ScriptExitError(
      1,
      `--seam must be one of: ${listSeamSelectionPolicies()
        .map((policy) => policy.seam_id)
        .join(', ')}`
    );
  }
  return id;
}

const SAVED_LAYERS: readonly SeamDefaultSavedLayer[] = [
  'operator',
  'tenant',
  'organization',
  'project',
];

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function defaultsScopeFlags(argv: Record<string, unknown>): SeamDefaultScope | undefined {
  const scope: SeamDefaultScope = {
    ...(optionalText(argv.tenant) ? { tenant_slug: optionalText(argv.tenant) } : {}),
    ...(optionalText(argv.organization)
      ? { organization_id: optionalText(argv.organization) }
      : {}),
    ...(optionalText(argv.project) ? { project_id: optionalText(argv.project) } : {}),
  };
  return Object.keys(scope).length ? scope : undefined;
}

/** --layer defaults to the most specific layer the flags name, else operator. */
function defaultsTarget(argv: Record<string, unknown>): SeamDefaultTarget {
  const scope = defaultsScopeFlags(argv) ?? {};
  const requested = optionalText(argv.layer);
  if (requested && !SAVED_LAYERS.includes(requested as SeamDefaultSavedLayer)) {
    throw new ScriptExitError(1, `--layer must be one of: ${SAVED_LAYERS.join(', ')}`);
  }
  const layer: SeamDefaultSavedLayer =
    (requested as SeamDefaultSavedLayer | undefined) ??
    (scope.project_id
      ? 'project'
      : scope.organization_id
        ? 'organization'
        : scope.tenant_slug
          ? 'tenant'
          : 'operator');
  if (layer === 'tenant' && !scope.tenant_slug) {
    throw new ScriptExitError(1, '--layer tenant needs --tenant');
  }
  if (layer === 'organization' && !scope.organization_id) {
    throw new ScriptExitError(1, '--layer organization needs --organization');
  }
  if (layer === 'project' && !scope.project_id) {
    throw new ScriptExitError(1, '--layer project needs --project');
  }
  return {
    layer,
    ...(layer !== 'operator' && scope.tenant_slug ? { tenant_slug: scope.tenant_slug } : {}),
    ...(layer === 'organization' ? { organization_id: scope.organization_id } : {}),
    ...(layer === 'project' ? { project_id: scope.project_id } : {}),
  };
}

function readJsonArg(file: unknown, label: string): unknown {
  if (typeof file !== 'string' || !file.trim())
    throw new ScriptExitError(1, `${label} is required`);
  const abs = assertSafeRepositoryPath(pathResolver.rootResolve(file.trim()));
  return readSafeJsonFile<unknown>(abs, label);
}

function scriptUserArgs(argv: readonly string[]): string[] {
  const cleaned = [...argv];
  while (cleaned.length > 0 && cleaned[0] === '--') cleaned.shift();
  return cleaned;
}

export const runSeamSelection = defineScript({
  name: 'seam-selection',
  flags: [],
  async run(context) {
    registerSeamCalibrationAdapters();
    const argv = createStandardYargs(['node', 'seam_selection', ...scriptUserArgs(context.argv)])
      .command('list', 'List seams, purposes, calibration adapters and operator rules')
      .command('explain', 'Show which provider would be chosen (no audit, no pin)')
      .command('calibrate', 'Run every candidate on the same input and write a comparison report')
      .command('rules', 'rules list | set | remove')
      .command('apply-measurements', 'Record measured trait values from a calibration report')
      .command('defaults', 'defaults list | set | unset (saved per-seam default provider)')
      .option('seam', { type: 'string' })
      .option('purpose', { type: 'string' })
      .option('context', { type: 'string', describe: 'key=value[,key=value]' })
      .option('eligible', { type: 'string', describe: 'explain: providers that can run the task' })
      .option('input', { type: 'string', describe: 'calibrate/explain: input JSON file' })
      .option('providers', { type: 'string' })
      .option('repeats', { type: 'number', default: 1 })
      .option('rule-id', { type: 'string' })
      .option('prefer', { type: 'string' })
      .option('evidence', { type: 'string' })
      .option('note', { type: 'string' })
      .option('report', { type: 'string' })
      .option('traits', { type: 'string' })
      .option('provider', { type: 'string', describe: 'defaults set: provider id' })
      .option('layer', {
        type: 'string',
        describe: 'defaults: operator | tenant | organization | project',
      })
      .option('tenant', { type: 'string' })
      .option('organization', { type: 'string' })
      .option('project', { type: 'string' })
      .parseSync();
    const [command, sub] = argv._.map(String);

    if (!command || command === 'list') {
      context.print(
        JSON.stringify(
          {
            seams: listSeamSelectionPolicies().map((policy) => ({
              seam: policy.seam_id,
              default_provider: policy.default_provider,
              fallback_purpose: policy.fallback_purpose,
              purposes: Object.keys(policy.purposes),
              providers: Object.keys(policy.providers),
              calibration: Boolean(getSeamCalibrationAdapter(policy.seam_id)),
            })),
            calibration_adapters: listSeamCalibrationAdapters().map((adapter) => ({
              seam: adapter.seam,
              description: adapter.description,
              input_example: adapter.input_example,
            })),
            rules_path: pathResolver.toRepoRelative(seamSelectionRulesPath()),
            rules: listSeamSelectionRules(),
            defaults_path: pathResolver.toRepoRelative(seamDefaultsOperatorPath()),
          },
          null,
          2
        )
      );
      return;
    }

    if (command === 'explain') {
      const seam = requireSeam(argv.seam);
      const policy = getSeamSelectionPolicy(seam)!;
      let candidates: SeamProviderCandidate[];
      const adapter = getSeamCalibrationAdapter(seam);
      if (argv.input && adapter) {
        candidates = await adapter.listCandidates(readJsonArg(argv.input, '--input'));
      } else {
        const eligible = csv(argv.eligible);
        candidates = Object.keys(policy.providers).map((id) => ({
          id,
          eligible: eligible.length === 0 || eligible.includes(id),
        }));
      }
      const decision = explainSeamProviderDecision({
        seam,
        candidates,
        ...(argv.purpose ? { purpose: argv.purpose } : {}),
        context: parseContext(argv.context),
        ...(argv.purpose ? { decisionKey: argv.purpose } : {}),
      });
      context.print(JSON.stringify(decision, null, 2));
      if (decision.strategy === 'unresolved') throw new ScriptExitError(2, decision.rationale);
      return;
    }

    if (command === 'calibrate') {
      const seam = requireSeam(argv.seam);
      const report = await withExecutionContextAsync(OPERATOR_ROLE, () =>
        runSeamCalibration({
          seam,
          input: readJsonArg(argv.input, '--input'),
          providers: csv(argv.providers),
          repeats: Number(argv.repeats || 1),
        })
      );
      context.print(
        JSON.stringify(
          {
            seam: report.seam,
            run_id: report.run_id,
            report_markdown: report.report_markdown,
            report_json: report.report_json,
            providers: report.providers.map((p) => ({
              provider_id: p.provider_id,
              eligible: p.eligible,
              success_rate: p.success_rate,
              latency_ms_median: p.latency_ms_median,
              metrics_mean: p.metrics_mean,
              skipped_reason: p.skipped_reason,
              unmet: p.unmet,
            })),
            suggested_traits: report.suggested_traits,
          },
          null,
          2
        )
      );
      return;
    }

    if (command === 'rules') {
      if (!sub || sub === 'list') {
        context.print(
          JSON.stringify(
            {
              rules_path: pathResolver.toRepoRelative(seamSelectionRulesPath()),
              rules: listSeamSelectionRules(argv.seam ? String(argv.seam) : undefined),
            },
            null,
            2
          )
        );
        return;
      }
      if (sub === 'set') {
        const seam = requireSeam(argv.seam);
        const ruleId = String(argv['rule-id'] || '').trim();
        const prefer = csv(argv.prefer);
        if (!ruleId || prefer.length === 0) {
          throw new ScriptExitError(1, 'rules set needs --rule-id and --prefer');
        }
        const policy = getSeamSelectionPolicy(seam)!;
        const purpose = argv.purpose ? String(argv.purpose) : undefined;
        if (purpose && !policy.purposes[purpose]) {
          throw new ScriptExitError(
            1,
            `unknown purpose '${purpose}' (known: ${Object.keys(policy.purposes).join(', ')})`
          );
        }
        const unknown = prefer.filter((id) => !policy.providers[id]);
        if (unknown.length) {
          throw new ScriptExitError(
            1,
            `unknown providers for ${seam}: ${unknown.join(', ')} (known: ${Object.keys(policy.providers).join(', ')})`
          );
        }
        const result = await withExecutionContextAsync(OPERATOR_ROLE, () =>
          setSeamSelectionRule({
            rule_id: ruleId,
            seam,
            when: { ...(purpose ? { purpose } : {}), context: parseContext(argv.context) },
            prefer,
            ...(argv.note ? { note: String(argv.note) } : {}),
            evidence: csv(argv.evidence),
          })
        );
        context.print(
          JSON.stringify(
            { saved: pathResolver.toRepoRelative(result.path), rule: result.rule },
            null,
            2
          )
        );
        return;
      }
      if (sub === 'remove') {
        const ruleId = String(argv['rule-id'] || '').trim();
        if (!ruleId) throw new ScriptExitError(1, 'rules remove needs --rule-id');
        const removed = await withExecutionContextAsync(OPERATOR_ROLE, () =>
          removeSeamSelectionRule(ruleId)
        );
        if (!removed) throw new ScriptExitError(1, `no rule '${ruleId}'`);
        context.print(JSON.stringify({ removed: ruleId }, null, 2));
        return;
      }
      throw new ScriptExitError(1, `unknown rules subcommand '${sub}' (list | set | remove)`);
    }

    if (command === 'defaults') {
      if (!sub || sub === 'list') {
        const scope = defaultsScopeFlags(argv);
        const policies = argv.seam
          ? [getSeamSelectionPolicy(requireSeam(argv.seam))!]
          : listSeamSelectionPolicies();
        context.print(
          JSON.stringify(
            {
              scope: scope ?? 'current',
              seams: policies.map((policy) => {
                const layers = listSavedSeamDefaultLayers(policy.seam_id, scope);
                return {
                  seam: policy.seam_id,
                  effective: layers[0]
                    ? { provider: layers[0].provider, layer: layers[0].layer }
                    : { provider: policy.default_provider, layer: 'policy' },
                  policy_default: policy.default_provider,
                  policy_chain: seamPolicyDefaultChain(policy),
                  layers,
                };
              }),
            },
            null,
            2
          )
        );
        return;
      }
      if (sub === 'set' || sub === 'unset') {
        const seam = requireSeam(argv.seam);
        const target = defaultsTarget(argv);
        if (sub === 'set') {
          const provider = optionalText(argv.provider);
          const policy = getSeamSelectionPolicy(seam)!;
          if (!provider || !policy.providers[provider]) {
            throw new ScriptExitError(
              1,
              `--provider must be one of: ${Object.keys(policy.providers).join(', ')}`
            );
          }
          const result = await withExecutionContextAsync(OPERATOR_ROLE, () =>
            setSeamDefault({
              seam,
              provider,
              ...target,
              ...(argv.note ? { note: String(argv.note) } : {}),
            })
          );
          context.print(
            JSON.stringify(
              {
                saved: pathResolver.toRepoRelative(result.path),
                seam,
                ...target,
                entry: result.entry,
              },
              null,
              2
            )
          );
          return;
        }
        const removed = await withExecutionContextAsync(OPERATOR_ROLE, () =>
          unsetSeamDefault({ seam, ...target })
        );
        const filePath =
          target.layer === 'operator'
            ? seamDefaultsOperatorPath()
            : seamDefaultsScopePath(target.tenant_slug);
        context.print(
          JSON.stringify(
            {
              removed,
              seam,
              ...target,
              path: pathResolver.toRepoRelative(filePath),
              remaining: Object.keys(readSeamDefaultLayer(target)),
            },
            null,
            2
          )
        );
        return;
      }
      throw new ScriptExitError(1, `unknown defaults subcommand '${sub}' (list | set | unset)`);
    }

    if (command === 'apply-measurements') {
      const report = readJsonArg(argv.report, '--report') as SeamCalibrationReport;
      const policy = getSeamSelectionPolicy(report.seam);
      if (!policy) throw new ScriptExitError(1, `report seam '${report.seam}' has no policy`);
      const wantedTraits = csv(argv.traits);
      const wantedProviders = csv(argv.providers);
      const values: Record<string, Record<string, number>> = {};
      for (const [trait, byProvider] of Object.entries(report.suggested_traits ?? {})) {
        if (wantedTraits.length && !wantedTraits.includes(trait)) continue;
        if (!policy.traits[trait]) continue;
        for (const [providerId, value] of Object.entries(byProvider)) {
          if (wantedProviders.length && !wantedProviders.includes(providerId)) continue;
          (values[providerId] ??= {})[trait] = value;
        }
      }
      if (Object.keys(values).length === 0) {
        throw new ScriptExitError(
          1,
          `no measured traits to apply (report traits: ${Object.keys(report.suggested_traits ?? {}).join(', ') || 'none'}; policy traits: ${Object.keys(policy.traits).join(', ')})`
        );
      }
      const saved = await withExecutionContextAsync(OPERATOR_ROLE, () =>
        setSeamTraitOverrides({
          seam: report.seam,
          values,
          evidence: [String(argv.report)],
        })
      );
      context.print(
        JSON.stringify(
          { saved: pathResolver.toRepoRelative(saved), seam: report.seam, values },
          null,
          2
        )
      );
      return;
    }

    throw new ScriptExitError(
      1,
      `unknown command '${command}' (list | explain | calibrate | rules | apply-measurements | defaults)`
    );
  },
});

if (
  isDirectScript(import.meta.url, 'seam_selection.ts') ||
  isDirectScript(import.meta.url, 'seam_selection.js')
)
  void runSeamSelection();
