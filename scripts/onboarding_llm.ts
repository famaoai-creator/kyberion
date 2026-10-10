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
 * (a human statement about the purchased plan), and `training_use none` —
 * the one that opens confidential egress — additionally needs an approved
 * human approval request. Default stays deny: nothing here attests a
 * provider or approves a request on the operator's behalf.
 *
 * The exported helpers are shared with the interactive onboarding wizard.
 */
import { captureCliAttestationInvoker } from './lib/cli-attestation-invoker.js';
import { resolveIdentityContext, withExecutionContext } from '@agent/core/authority';
import { getRegisteredEnvText } from '@agent/core/foundation/env';
import { auditChain } from '@agent/core/governance/audit-chain';
import {
  getLlmSelectionSnapshot,
  loadLlmSelectionPreferences,
  saveLlmSelectionPreferences,
  validateLlmSelectionPreferences,
} from '@agent/core/llm-selection-preferences';
import {
  attestTenantProvider,
  assertPrintableCommandValue,
  captureAttestationInvoker,
  providerAttestationApplyArgs,
  requestTenantProviderAttestationApproval,
  shellQuoteArg,
  type AttestationInvoker,
  type ProviderAttestationApprovalRequest,
  type TenantProviderAttestationResult,
} from '@agent/core/organization/tenant-governance';
import {
  describeProviderTierAvailability,
  loadProviderEgressPolicy,
  type ProviderTierAvailabilityReport,
} from '@agent/core/provider/provider-egress-gate';
import { loadReasoningRoutePolicy } from '@agent/core/reasoning/reasoning-route-resolver';
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
      { flag: '--request-approval' },
      { flag: '--approval-request-id', value: '<id>' },
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
    '         material for LLM work and why the others are denied (--tenant, else the active',
    '         tenant scope).',
    '  select --backend <mode> [--model <model-id>] [--apply] [--json]',
    '         Record the reasoning backend (reasoning-backend-policy allowed_modes) and model',
    '         (model registry) in the operator LLM selection. Dry-run without --apply.',
    '  attest --tenant <slug> --provider <id> --training-use <none|used|unknown>',
    '         [--plan <text> --basis <url|ref> --attested-by <who>] [--valid-for-days <n>]',
    '         [--request-approval | --apply --accept [--approval-request-id <id>]] [--json]',
    '         State how this tenant’s plan with a provider treats data. used/unknown are',
    '         recorded with --apply --accept. none (with plan, basis, attested-by) lets',
    '         confidential/personal material reach that provider for this tenant only, so it',
    '         needs a human approval: --request-approval opens one, a human runs',
    '         `pnpm kyberion approvals --approve <id>`, then re-run with the same values and',
    '         --apply --accept --approval-request-id <id>. Audited; expires.',
  ].join('\n');
}

function optionValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  const value = index >= 0 ? argv[index + 1] : undefined;
  return value && !value.startsWith('--') ? value : undefined;
}

function ambientTenant(): string | undefined {
  try {
    return resolveIdentityContext().tenantSlug?.trim() || undefined;
  } catch {
    return undefined;
  }
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

/**
 * The tenant a view applies: `--tenant`, else the ambient scope. A process
 * bound to one tenant may not look at another tenant's attestations.
 */
function effectiveTenant(requested: string | undefined): string | undefined {
  const ambient = ambientTenant();
  if (requested && ambient && requested !== ambient) {
    throw new Error(
      `--tenant '${requested}' conflicts with the active tenant scope '${ambient}'; unset KYBERION_TENANT or pass the same tenant.`
    );
  }
  return requested || ambient;
}

export function availabilityFor(
  tenantSlug: string | undefined,
  options: OnboardingLlmOptions = {}
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

export function formatAvailability(report: ProviderTierAvailabilityReport): string[] {
  const tenantLabel =
    report.tenant_source === 'none'
      ? ' (no tenant)'
      : ` (tenant ${report.tenant_slug}${report.tenant_source === 'ambient' ? ', from the active tenant scope' : ''})`;
  const lines = [`LLM availability by data tier${tenantLabel}:`];
  for (const tier of report.tiers) {
    lines.push(`  ${tier.note}`);
    if (tier.tier === 'public') continue;
    for (const entry of tier.usable) lines.push(`    ✔ ${entry.provider} (${entry.basis})`);
    // One reason per denied provider would flood the screen; the first one
    // explains the shape, the full list is in --json.
    if (tier.denied.length > 0) {
      lines.push(
        `    ✘ denied: ${tier.denied.map((entry) => entry.provider).join(', ')} — e.g. ${tier.denied[0]!.reason}`
      );
    }
  }
  return lines;
}

/** Accept `claude-opus-5-5` as shorthand for the registry id `anthropic:claude-opus-5-5`. */
export function resolveModelId(model: string, registered: readonly string[]): string {
  if (registered.includes(model)) return model;
  const matches = registered.filter((id) => id.endsWith(`:${model}`));
  return matches.length === 1 ? matches[0]! : model;
}

/** The model the route policy uses for this backend when none is chosen. */
export function defaultModelForBackend(
  backend: string,
  registered: readonly string[]
): string | undefined {
  const policy = loadReasoningRoutePolicy();
  const profile = Object.values(policy.profiles).find((entry) => entry.mode === backend);
  const ref = profile?.model ?? profile?.model_ref;
  if (ref && registered.includes(ref)) return ref;
  return registered[0];
}

export interface LlmSelectionChange {
  selection: { provider: string; model_id?: string };
  storage_path: string;
  /** `.env.local` line rewritten so the choice takes effect (only that key). */
  env_local_change?: { path: string; key: string; from: string; to: string };
  warnings: string[];
}

/** Validate a backend/model choice without writing anything. */
export function planLlmSelection(input: {
  backend: string;
  model?: string;
  envLocalPath?: string;
}): LlmSelectionChange {
  const backend = normalizeReasoningBackendChoice(input.backend);
  if (!backend) {
    throw new Error(
      `Invalid --backend '${input.backend}'. Allowed (reasoning-backend-policy.json allowed_modes): ${listReasoningBackendChoices().join(', ')}`
    );
  }
  const envLocalPath = input.envLocalPath ?? defaultEnvLocalPath();
  // The runtime must be selectable here (credentials, endpoint or CLI present)
  // and the model must be in the governed registry.
  const snapshot = getLlmSelectionSnapshot();
  const candidate = snapshot.candidates.find((entry) => entry.provider === backend);
  const model = input.model?.trim()
    ? resolveModelId(input.model.trim(), candidate?.model_ids ?? [])
    : undefined;
  const validated = validateLlmSelectionPreferences(
    { provider: backend, ...(model ? { model_id: model } : {}) },
    snapshot
  );
  // A persisted KYBERION_REASONING_BACKEND (the wizard writes one) wins over
  // the selection file in shells that load .env.local, so an explicit choice
  // updates that one line too.
  const persisted = readPersistedReasoningBackend(envLocalPath);
  const shellBackend = getRegisteredEnvText('KYBERION_REASONING_BACKEND')?.trim();
  return {
    selection: validated,
    storage_path: snapshot.storage_path,
    ...(persisted && persisted !== backend
      ? {
          env_local_change: {
            path: envLocalPath,
            key: 'KYBERION_REASONING_BACKEND',
            from: persisted,
            to: backend,
          },
        }
      : {}),
    warnings:
      shellBackend && shellBackend !== backend && shellBackend !== persisted
        ? [
            `KYBERION_REASONING_BACKEND=${shellBackend} is exported in this shell and overrides the selection; unset it.`,
          ]
        : [],
  };
}

/** Record a validated backend/model choice and audit it as `actor`. */
export function applyLlmSelection(input: {
  backend: string;
  model?: string;
  envLocalPath?: string;
  actor: string;
}): LlmSelectionChange {
  const plan = planLlmSelection(input);
  return withExecutionContext('sovereign_concierge', () => {
    const saved = saveLlmSelectionPreferences(plan.selection);
    if (plan.env_local_change) {
      persistReasoningBackend(plan.env_local_change.to, plan.env_local_change.path);
    }
    auditChain.record({
      agentId: input.actor,
      action: 'onboarding.llm_select',
      operation: 'reasoning:llm-selection',
      result: 'completed',
      metadata: {
        provider: saved.preferences.provider,
        ...(saved.preferences.model_id ? { model_id: saved.preferences.model_id } : {}),
        storage_path: saved.storage_path,
        ...(plan.env_local_change ? { env_local_change: plan.env_local_change } : {}),
      },
    });
    return {
      ...plan,
      selection: {
        provider: saved.preferences.provider,
        ...(saved.preferences.model_id ? { model_id: saved.preferences.model_id } : {}),
      },
      storage_path: saved.storage_path,
    };
  });
}

function describeSelection(change: LlmSelectionChange, dryRun: boolean): string[] {
  const prefix = dryRun ? '[dry-run] would record' : 'Recorded';
  const env = change.env_local_change;
  return [
    `${prefix} backend=${change.selection.provider}${change.selection.model_id ? ` model=${change.selection.model_id}` : ''} in ${change.storage_path}`,
    ...(env
      ? [
          `${dryRun ? '[dry-run] would update' : 'Updated'} ${env.path}: ${env.key} ${env.from} -> ${env.to} (other lines unchanged)`,
        ]
      : []),
    ...change.warnings.map((warning) => `warning: ${warning}`),
  ];
}

export interface ProviderAttestationInput {
  tenant: string;
  provider: string;
  training_use: 'none' | 'used' | 'unknown';
  plan?: string;
  basis?: string;
  attested_by?: string;
  valid_for_days?: number;
  approvalRequestId?: string;
  invoker: AttestationInvoker;
  tenantRegistryRootDir?: string;
}

function toCoreAttestation(input: ProviderAttestationInput) {
  return {
    invoker: input.invoker,
    slug: input.tenant,
    provider: input.provider,
    training_use: input.training_use,
    ...(input.plan ? { plan: input.plan } : {}),
    ...(input.basis ? { basis: input.basis } : {}),
    ...(input.attested_by ? { attested_by: input.attested_by } : {}),
    ...(input.valid_for_days !== undefined ? { valid_for_days: input.valid_for_days } : {}),
    ...(input.approvalRequestId ? { approvalRequestId: input.approvalRequestId } : {}),
    ...(input.tenantRegistryRootDir ? { rootDir: input.tenantRegistryRootDir } : {}),
  };
}

/** Open (or reuse) the human approval a `training_use: none` attestation needs. */
export function requestProviderAttestationApproval(
  input: ProviderAttestationInput
): ProviderAttestationApprovalRequest {
  return withExecutionContext(
    'sovereign_concierge',
    () => requestTenantProviderAttestationApproval(toCoreAttestation(input)),
    undefined,
    input.tenant
  );
}

/** Record an attestation (an approved request is required for `none`). */
export function applyProviderAttestation(
  input: ProviderAttestationInput
): TenantProviderAttestationResult {
  return withExecutionContext(
    'sovereign_concierge',
    () => attestTenantProvider(toCoreAttestation(input)),
    undefined,
    input.tenant
  );
}

function show(argv: readonly string[], print: Print, options: OnboardingLlmOptions): void {
  const requested = requireTenant(argv, false);
  const tenant = effectiveTenant(requested);
  const selection = withExecutionContext('sovereign_concierge', () =>
    loadLlmSelectionPreferences()
  );
  const envBackend = getRegisteredEnvText('KYBERION_REASONING_BACKEND')?.trim() || null;
  const persistedBackend = readPersistedReasoningBackend(
    options.envLocalPath ?? defaultEnvLocalPath()
  );
  const availability: ProviderTierAvailabilityReport = {
    ...availabilityFor(tenant, options),
    tenant_source: requested ? 'argument' : tenant ? 'ambient' : 'none',
  };
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
      ...(envBackend && envBackend !== selection?.provider
        ? [`KYBERION_REASONING_BACKEND=${envBackend} (environment wins)`]
        : []),
      `Allowed backends: ${result.allowed_backends.join(', ')}`,
      ...formatAvailability(availability),
    ].join('\n')
  );
}

function select(argv: readonly string[], print: Print, options: OnboardingLlmOptions): void {
  const backend = optionValue(argv, '--backend');
  if (!backend) throw new Error('select requires --backend <mode>');
  const model = optionValue(argv, '--model');
  const input = {
    backend,
    ...(model ? { model } : {}),
    ...(options.envLocalPath ? { envLocalPath: options.envLocalPath } : {}),
  };
  if (!argv.includes('--apply')) {
    const plan = planLlmSelection(input);
    print(
      argv.includes('--json')
        ? JSON.stringify({ dry_run: true, ...plan }, null, 2)
        : [...describeSelection(plan, true), 'Re-run with --apply to record it.'].join('\n')
    );
    return;
  }
  // Attribute the audit entry to whoever asked, not the facade's elevation.
  const actor = captureAttestationInvoker().actor;
  const change = applyLlmSelection({ ...input, actor });
  print(
    argv.includes('--json')
      ? JSON.stringify({ applied: true, ...change }, null, 2)
      : describeSelection(change, false).join('\n')
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
  // Parse-time: these values are echoed in a copy-pasteable command.
  assertPrintableCommandValue('--plan', plan);
  assertPrintableCommandValue('--basis', basis);
  assertPrintableCommandValue('--attested-by', attestedBy);
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
  const approvalRequestId = optionValue(argv, '--approval-request-id');
  // Capture who asked (and their tenant binding) before any elevation.
  const input: ProviderAttestationInput = {
    tenant,
    provider,
    training_use: trainingUse,
    ...(plan ? { plan } : {}),
    ...(basis ? { basis } : {}),
    ...(attestedBy ? { attested_by: attestedBy } : {}),
    ...(validForDays !== undefined ? { valid_for_days: validForDays } : {}),
    ...(approvalRequestId ? { approvalRequestId } : {}),
    invoker: captureCliAttestationInvoker(),
    ...(options.tenantRegistryRootDir
      ? { tenantRegistryRootDir: options.tenantRegistryRootDir }
      : {}),
  };
  const json = argv.includes('--json');

  if (argv.includes('--request-approval')) {
    const request = requestProviderAttestationApproval(input);
    // Print every bound value verbatim and shell-quoted: the approval is
    // hash-bound to plan/basis/attested_by/valid_for_days, so the command
    // must apply as-is when pasted.
    const applyCommand = [
      'pnpm',
      'onboarding',
      'llm',
      'attest',
      '--tenant',
      tenant,
      ...providerAttestationApplyArgs(
        {
          provider,
          training_use: trainingUse,
          plan,
          basis,
          attested_by: attestedBy,
          valid_for_days: validForDays,
        },
        request.request_id
      ),
    ]
      .map(shellQuoteArg)
      .join(' ');
    print(
      json
        ? JSON.stringify(
            { ...request, apply_command: applyCommand, apply_command_shell: 'posix' },
            null,
            2
          )
        : [
            `${request.created ? 'Opened' : 'Reusing'} approval request ${request.request_id} (${request.status}${request.expires_at ? `, expires ${request.expires_at}` : ''})`,
            `A human decides with: ${request.approve_command}`,
            `Then apply with the same values (POSIX shell: sh/bash/zsh): ${applyCommand}`,
          ].join('\n')
    );
    return;
  }

  const apply = argv.includes('--apply');
  if (apply && !argv.includes('--accept')) {
    throw new Error(
      'attest --apply requires --accept: the attestation is your statement about the plan’s training-use terms'
    );
  }
  if (!apply) {
    const availability = availabilityFor(effectiveTenant(tenant), options);
    const needsApproval = trainingUse === 'none' && !approvalRequestId;
    const preview = {
      dry_run: true,
      attestation: { ...input, invoker: undefined },
      ...(needsApproval ? { needs_approval: 'run with --request-approval first' } : {}),
      current_availability: availability,
    };
    print(
      json
        ? JSON.stringify(preview, null, 2)
        : [
            `[dry-run] would attest tenant=${tenant} provider=${provider} training_use=${trainingUse}`,
            ...formatAvailability(availability),
            needsApproval
              ? 'training_use none opens confidential egress: run with --request-approval, have a human approve it, then --apply --accept --approval-request-id <id>.'
              : 'Re-run with --apply --accept to record it.',
          ].join('\n')
    );
    return;
  }

  const recorded = applyProviderAttestation(input);
  const availability = availabilityFor(tenant, options);
  const output = {
    applied: true,
    tenant,
    provider,
    attestation: recorded.attestation,
    profile_path: recorded.profile_path,
    ...(recorded.approval ? { approval: recorded.approval } : {}),
    availability,
  };
  print(
    json
      ? JSON.stringify(output, null, 2)
      : [
          `Attested tenant=${tenant} provider=${provider} training_use=${recorded.attestation.training_use}${recorded.attestation.expires_at ? ` (expires ${recorded.attestation.expires_at})` : ''}`,
          `Recorded in ${recorded.profile_path}; audit action tenant.attest_provider${recorded.approval ? ` (approved by ${recorded.approval.approved_by}, request ${recorded.approval.request_id})` : ''}`,
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
