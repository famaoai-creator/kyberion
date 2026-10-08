/**
 * `pnpm onboarding llm` — choose the reasoning backend/model and record
 * per-tenant provider egress attestations during onboarding.
 *
 * This adds no new persistence. It is a guided front door over the governed
 * mechanisms that already exist:
 * - backend/model → the operator LLM selection (`<profile-root>/onboarding/
 *   llm-selection.json`, `saveLlmSelectionPreferences`), which the route
 *   resolver and reasoning bootstrap already read;
 * - provider egress → the tenant provider attestation
 *   (`attestTenantProvider`, the same path as `pnpm tenant attest-provider`),
 *   which `checkProviderEgress` already honours.
 *
 * Writes are dry-run unless `--apply`; an attestation also needs `--accept`
 * (a human statement about the purchased plan). Default stays deny: nothing
 * here attests a provider on the operator's behalf.
 */
import { withExecutionContext } from '@agent/core/authority';
import { getRegisteredEnvText } from '@agent/core/foundation/env';
import { auditChain } from '@agent/core/governance/audit-chain';
import {
  getLlmSelectionSnapshot,
  loadLlmSelectionPreferences,
  saveLlmSelectionPreferences,
  validateLlmSelectionPreferences,
} from '@agent/core/llm-selection-preferences';
import { attestTenantProvider } from '@agent/core/organization/tenant-governance';
import {
  describeProviderTierAvailability,
  loadProviderEgressPolicy,
  type ProviderTierAvailabilityReport,
} from '@agent/core/provider/provider-egress-gate';
import { isValidTenantSlug } from '@agent/core/foundation/scope';
import { guardCliArgsNormalized, type CliGuardSpec } from './lib/cli-guard.js';
import {
  defaultEnvLocalPath,
  listReasoningBackendChoices,
  normalizeReasoningBackendChoice,
  persistReasoningBackend,
  readPersistedReasoningBackend,
} from './reasoning_backend_selection.js';

type Print = (value: unknown) => void;

export interface OnboardingLlmOptions {
  /** `.env.local` holding a persisted KYBERION_REASONING_BACKEND (tests inject a fixture). */
  envLocalPath?: string;
  /** Alternate repository root for the tenant registry (hermetic tests). */
  tenantRegistryRootDir?: string;
}

const VERBS = ['show', 'select', 'attest'] as const;
type Verb = (typeof VERBS)[number];

const SPECS: Record<Verb, CliGuardSpec> = {
  show: {
    command: 'pnpm onboarding llm show',
    manifestId: 'script.onboarding',
    options: [{ flag: '--tenant', value: '<tenant-slug>' }, { flag: '--json' }],
  },
  select: {
    command: 'pnpm onboarding llm select',
    manifestId: 'script.onboarding',
    options: [
      { flag: '--backend', value: '<mode>' },
      { flag: '--model', value: '<model-id>' },
      { flag: '--apply' },
      { flag: '--json' },
    ],
  },
  attest: {
    command: 'pnpm onboarding llm attest',
    manifestId: 'script.onboarding',
    options: [
      { flag: '--tenant', value: '<tenant-slug>' },
      { flag: '--provider', value: '<provider-id>' },
      { flag: '--training-use', value: '<none|used|unknown>' },
      { flag: '--plan', value: '<text>' },
      { flag: '--basis', value: '<url|ref>' },
      { flag: '--attested-by', value: '<who>' },
      { flag: '--valid-for-days', value: '<n>' },
      { flag: '--apply' },
      { flag: '--accept' },
      { flag: '--json' },
    ],
  },
};

export function onboardingLlmUsage(): string {
  return [
    'Usage: pnpm onboarding llm <show|select|attest> [options]',
    '  show   [--tenant <slug>] [--json]',
    '         Current backend/model selection and, per data tier, which providers may receive',
    '         material for LLM work (with --tenant: that tenant’s attestations apply).',
    '  select --backend <mode> [--model <model-id>] [--apply] [--json]',
    '         Record the reasoning backend (reasoning-backend-policy allowed_modes) and model',
    '         (model registry) in the operator LLM selection. Dry-run without --apply.',
    '  attest --tenant <slug> --provider <id> --training-use <none|used|unknown>',
    '         [--plan <text> --basis <url|ref> --attested-by <who>] [--valid-for-days <n>]',
    '         [--apply --accept] [--json]',
    '         State how this tenant’s plan with a provider treats data. training_use none',
    '         (with plan, basis and attested-by) lets confidential/personal material reach that',
    '         provider for this tenant only; it is audited and expires. Nothing is attested',
    '         by default; --apply --accept is your explicit confirmation.',
  ].join('\n');
}

function optionValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  const value = index >= 0 ? argv[index + 1] : undefined;
  return value && !value.startsWith('--') ? value : undefined;
}

function requireTenant(argv: readonly string[], required: boolean): string | undefined {
  const tenant = optionValue(argv, '--tenant')?.trim();
  if (!tenant) {
    if (required) throw new Error('--tenant <tenant-slug> is required');
    return undefined;
  }
  if (!isValidTenantSlug(tenant)) {
    throw new Error(`--tenant '${tenant}' is not a valid tenant slug`);
  }
  return tenant;
}

function availabilityFor(
  tenantSlug: string | undefined,
  options: OnboardingLlmOptions
): ProviderTierAvailabilityReport {
  return withExecutionContext(
    'sovereign_concierge',
    () =>
      describeProviderTierAvailability({
        ...(tenantSlug ? { tenant_slug: tenantSlug } : {}),
        ...(options.tenantRegistryRootDir
          ? { tenant_registry_root_dir: options.tenantRegistryRootDir }
          : {}),
      }),
    undefined,
    tenantSlug
  );
}

function formatAvailability(report: ProviderTierAvailabilityReport): string[] {
  return [
    `LLM availability by data tier${report.tenant_slug ? ` (tenant ${report.tenant_slug})` : ' (no tenant)'}:`,
    ...report.tiers.map((tier) => `  ${tier.note}`),
  ];
}

/** Accept `claude-opus-5-5` as shorthand for the registry id `anthropic:claude-opus-5-5`. */
function resolveModelId(model: string, registered: readonly string[]): string {
  if (registered.includes(model)) return model;
  const matches = registered.filter((id) => id.endsWith(`:${model}`));
  return matches.length === 1 ? matches[0]! : model;
}

function show(argv: readonly string[], print: Print, options: OnboardingLlmOptions): void {
  const tenant = requireTenant(argv, false);
  const selection = withExecutionContext('sovereign_concierge', () =>
    loadLlmSelectionPreferences()
  );
  const envBackend = getRegisteredEnvText('KYBERION_REASONING_BACKEND')?.trim() || null;
  const persistedBackend = readPersistedReasoningBackend(
    options.envLocalPath ?? defaultEnvLocalPath()
  );
  const availability = availabilityFor(tenant, options);
  const result = {
    selection,
    env_backend: envBackend,
    env_local_backend: persistedBackend,
    allowed_backends: listReasoningBackendChoices(),
    availability,
  };
  if (argv.includes('--json')) {
    print(JSON.stringify(result, null, 2));
    return;
  }
  print(
    [
      `Reasoning selection: ${selection ? `${selection.provider}${selection.model_id ? ` (model ${selection.model_id})` : ''}` : '(none recorded — auto-discovery)'}`,
      ...(envBackend ? [`KYBERION_REASONING_BACKEND=${envBackend} (environment wins)`] : []),
      `Allowed backends: ${result.allowed_backends.join(', ')}`,
      ...formatAvailability(availability),
    ].join('\n')
  );
}

function select(argv: readonly string[], print: Print, options: OnboardingLlmOptions): void {
  const rawBackend = optionValue(argv, '--backend');
  if (!rawBackend) throw new Error('select requires --backend <mode>');
  const backend = normalizeReasoningBackendChoice(rawBackend);
  if (!backend) {
    throw new Error(
      `Invalid --backend '${rawBackend}'. Allowed (reasoning-backend-policy.json allowed_modes): ${listReasoningBackendChoices().join(', ')}`
    );
  }
  const rawModel = optionValue(argv, '--model')?.trim();
  const apply = argv.includes('--apply');
  const envLocalPath = options.envLocalPath ?? defaultEnvLocalPath();

  // Validate before any write: the runtime must be selectable here (credentials,
  // endpoint or CLI present) and the model must be in the governed registry.
  const snapshot = getLlmSelectionSnapshot();
  const candidate = snapshot.candidates.find((entry) => entry.provider === backend);
  const model = rawModel ? resolveModelId(rawModel, candidate?.model_ids ?? []) : undefined;
  const validated = validateLlmSelectionPreferences(
    { provider: backend, ...(model ? { model_id: model } : {}) },
    snapshot
  );

  // A persisted KYBERION_REASONING_BACKEND (the wizard writes one) wins over
  // the selection file, so an explicit choice must update it too or it would
  // silently not take effect.
  const persistedBackend = readPersistedReasoningBackend(envLocalPath);
  const envLocalNeedsUpdate = Boolean(persistedBackend && persistedBackend !== backend);
  const shellBackend = getRegisteredEnvText('KYBERION_REASONING_BACKEND')?.trim();
  const warnings =
    shellBackend && shellBackend !== backend && shellBackend !== persistedBackend
      ? [
          `KYBERION_REASONING_BACKEND=${shellBackend} is exported in this shell and overrides the selection; unset it.`,
        ]
      : [];

  if (!apply) {
    const plan = {
      dry_run: true,
      selection: validated,
      storage_path: snapshot.storage_path,
      ...(envLocalNeedsUpdate
        ? { env_local_update: { path: envLocalPath, from: persistedBackend, to: backend } }
        : {}),
      warnings,
    };
    print(
      argv.includes('--json')
        ? JSON.stringify(plan, null, 2)
        : [
            `[dry-run] would record backend=${validated.provider}${validated.model_id ? ` model=${validated.model_id}` : ''} in ${snapshot.storage_path}`,
            ...(envLocalNeedsUpdate
              ? [
                  `[dry-run] would update KYBERION_REASONING_BACKEND ${persistedBackend} -> ${backend} in ${envLocalPath}`,
                ]
              : []),
            ...warnings.map((warning) => `warning: ${warning}`),
            'Re-run with --apply to record it.',
          ].join('\n')
    );
    return;
  }

  const saved = withExecutionContext('sovereign_concierge', () => {
    const result = saveLlmSelectionPreferences(validated);
    if (envLocalNeedsUpdate) persistReasoningBackend(backend, envLocalPath);
    auditChain.record({
      agentId: getRegisteredEnvText('KYBERION_PERSONA') || 'operator',
      action: 'onboarding.llm_select',
      operation: 'reasoning:llm-selection',
      result: 'completed',
      metadata: {
        provider: result.preferences.provider,
        ...(result.preferences.model_id ? { model_id: result.preferences.model_id } : {}),
        storage_path: result.storage_path,
        ...(envLocalNeedsUpdate ? { env_local_updated: envLocalPath } : {}),
      },
    });
    return result;
  });
  const output = {
    applied: true,
    selection: saved.preferences,
    storage_path: saved.storage_path,
    ...(envLocalNeedsUpdate ? { env_local_updated: envLocalPath } : {}),
    warnings,
  };
  print(
    argv.includes('--json')
      ? JSON.stringify(output, null, 2)
      : [
          `Recorded backend=${saved.preferences.provider}${saved.preferences.model_id ? ` model=${saved.preferences.model_id}` : ''} in ${saved.storage_path}`,
          ...(envLocalNeedsUpdate
            ? [`Updated KYBERION_REASONING_BACKEND=${backend} in ${envLocalPath}`]
            : []),
          ...warnings.map((warning) => `warning: ${warning}`),
        ].join('\n')
  );
}

function attest(argv: readonly string[], print: Print, options: OnboardingLlmOptions): void {
  const tenant = requireTenant(argv, true)!;
  const provider = optionValue(argv, '--provider')?.trim();
  if (!provider) throw new Error('attest requires --provider <provider-id>');
  const loaded = loadProviderEgressPolicy();
  const known = loaded.status === 'ok' ? Object.keys(loaded.policy.providers).sort() : [];
  if (!known.includes(provider)) {
    throw new Error(
      `Unknown --provider '${provider}'. Declared in provider-egress-policy.json: ${known.join(', ') || '(policy unavailable)'}`
    );
  }
  const trainingUse = optionValue(argv, '--training-use');
  if (trainingUse !== 'none' && trainingUse !== 'used' && trainingUse !== 'unknown') {
    throw new Error('attest requires an explicit --training-use <none|used|unknown>');
  }
  const plan = optionValue(argv, '--plan');
  const basis = optionValue(argv, '--basis');
  const attestedBy = optionValue(argv, '--attested-by');
  if (trainingUse === 'none') {
    const missing = [
      !plan?.trim() ? '--plan' : '',
      !basis?.trim() ? '--basis' : '',
      !attestedBy?.trim() ? '--attested-by' : '',
    ].filter(Boolean);
    if (missing.length > 0) {
      throw new Error(
        `attest --training-use none requires ${missing.join(', ')} for evidence and attribution`
      );
    }
  }
  const validForRaw = optionValue(argv, '--valid-for-days');
  const validForDays = validForRaw === undefined ? undefined : Number(validForRaw);
  if (validForDays !== undefined && (!Number.isFinite(validForDays) || validForDays <= 0)) {
    throw new Error('--valid-for-days must be a finite positive number');
  }

  const request = {
    tenant,
    provider,
    training_use: trainingUse,
    ...(plan ? { plan } : {}),
    ...(basis ? { basis } : {}),
    ...(attestedBy ? { attested_by: attestedBy } : {}),
    ...(validForDays !== undefined ? { valid_for_days: validForDays } : {}),
  };
  const apply = argv.includes('--apply');
  if (apply && !argv.includes('--accept')) {
    throw new Error(
      'attest --apply requires --accept: the attestation is your statement about the plan’s training-use terms'
    );
  }
  if (!apply) {
    const availability = availabilityFor(tenant, options);
    const preview = { dry_run: true, attestation: request, current_availability: availability };
    print(
      argv.includes('--json')
        ? JSON.stringify(preview, null, 2)
        : [
            `[dry-run] would attest tenant=${tenant} provider=${provider} training_use=${trainingUse}`,
            ...formatAvailability(availability),
            'Re-run with --apply --accept to record it.',
          ].join('\n')
    );
    return;
  }

  const recorded = withExecutionContext('sovereign_concierge', () =>
    attestTenantProvider({
      slug: tenant,
      provider,
      training_use: trainingUse,
      ...(plan ? { plan } : {}),
      ...(basis ? { basis } : {}),
      ...(attestedBy ? { attested_by: attestedBy } : {}),
      ...(validForDays !== undefined ? { valid_for_days: validForDays } : {}),
      ...(options.tenantRegistryRootDir ? { rootDir: options.tenantRegistryRootDir } : {}),
    })
  );
  const availability = availabilityFor(tenant, options);
  const output = {
    applied: true,
    tenant,
    provider,
    attestation: recorded.attestation,
    profile_path: recorded.profile_path,
    availability,
  };
  print(
    argv.includes('--json')
      ? JSON.stringify(output, null, 2)
      : [
          `Attested tenant=${tenant} provider=${provider} training_use=${recorded.attestation.training_use}${recorded.attestation.expires_at ? ` (expires ${recorded.attestation.expires_at})` : ''}`,
          `Recorded in ${recorded.profile_path}; audit action tenant.attest_provider`,
          ...formatAvailability(availability),
        ].join('\n')
  );
}

export function main(
  argv: string[] = [],
  print: Print = () => undefined,
  options: OnboardingLlmOptions = {}
): void {
  const verb = argv[0];
  if (!verb || !(VERBS as readonly string[]).includes(verb)) {
    if (verb && verb !== 'help' && verb !== '--help' && verb !== '-h') {
      throw new Error(`Unknown onboarding llm subcommand '${verb}'.\n${onboardingLlmUsage()}`);
    }
    print(onboardingLlmUsage());
    return;
  }
  const { handled, argv: rest } = guardCliArgsNormalized(argv.slice(1), SPECS[verb as Verb], print);
  if (handled) return;
  if (verb === 'show') return show(rest, print, options);
  if (verb === 'select') return select(rest, print, options);
  return attest(rest, print, options);
}
