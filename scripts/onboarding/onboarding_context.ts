#!/usr/bin/env node
import * as path from 'node:path';
import {
  applyOnboardingContextBinding,
  applyOnboardingFirstWork,
  loadOnboardingContextBinding,
  loadOnboardingFirstWorkRecord,
  OnboardingStanceMissingError,
  resolveOnboardingContext,
  resolveOnboardingFirstWork,
} from '@agent/core/organization/onboarding-context';
import * as customerResolver from '@agent/core/stance-resolver';
import {
  loadOrganizationOperationalState,
  type OrganizationTier,
} from '@agent/core/organization/organization-operating-model';
import { assertTenantOperational, resolveTenant } from '@agent/core/organization/tenant-registry';
import { resolveIdentityContext, withExecutionContext } from '@agent/core/authority';
import { defineScript, isDirectScript, ScriptExitError } from '../lib/harness.js';

type Print = (value: unknown) => void;

type ParsedArgs = {
  command: string;
  rootDir?: string;
  customerSlug?: string;
  tenantSlug?: string;
  organizationId?: string;
  tier?: OrganizationTier;
  ownerId?: string;
  organizationName?: string;
  purpose?: string;
  intent?: string;
  projectId?: string;
  projectName?: string;
  projectSummary?: string;
  serviceId?: string;
  trackId?: string;
  trackName?: string;
  serviceBindings?: string[];
  apply: boolean;
  accept: boolean;
  bootstrapProject: boolean;
  json: boolean;
};

function value(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  const candidate = index >= 0 ? argv[index + 1] : undefined;
  return candidate && !candidate.startsWith('--') ? candidate : undefined;
}

function parseTier(raw: string | undefined): OrganizationTier | undefined {
  if (!raw) return undefined;
  if (raw === 'personal' || raw === 'confidential' || raw === 'public') return raw;
  throw new Error(`Invalid tier: ${raw}`);
}

function parseArgs(argv: string[]): ParsedArgs {
  const command = argv.filter(
    (entry) => !entry.startsWith('--') && entry !== value(argv, '--intent')
  )[0];
  if (!command || command === 'help')
    return { command: 'help', apply: false, accept: false, bootstrapProject: false, json: false };
  const subcommand =
    command === 'organization'
      ? 'organization'
      : argv.includes('first-work')
        ? 'first-work'
        : argv.includes('bind')
          ? 'bind'
          : 'show';
  return {
    command: subcommand,
    rootDir: value(argv, '--root-dir') ? path.resolve(value(argv, '--root-dir')!) : undefined,
    customerSlug:
      subcommand === 'organization'
        ? undefined
        : value(argv, '--customer-slug') || customerResolver.activeStance() || undefined,
    tenantSlug: value(argv, '--tenant-slug'),
    organizationId: value(argv, '--organization-id'),
    tier: parseTier(value(argv, '--tier')),
    ownerId: value(argv, '--owner-id'),
    organizationName: value(argv, '--organization-name'),
    purpose: value(argv, '--purpose'),
    intent: value(argv, '--intent'),
    projectId: value(argv, '--project-id'),
    projectName: value(argv, '--project-name'),
    projectSummary: value(argv, '--project-summary'),
    serviceId: value(argv, '--service-id'),
    trackId: value(argv, '--track-id'),
    trackName: value(argv, '--track-name'),
    serviceBindings: value(argv, '--service-bindings')
      ?.split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
    apply: argv.includes('--apply'),
    accept: argv.includes('--accept'),
    bootstrapProject: argv.includes('--bootstrap-project'),
    json: argv.includes('--json'),
  };
}

function customerRequired(args: ParsedArgs): string {
  if (!args.customerSlug)
    throw new Error('--customer-slug is required when no active customer is configured.');
  return args.customerSlug;
}

function emit(valueToPrint: unknown, print: Print): void {
  print(JSON.stringify(valueToPrint, null, 2));
}

function usage(): string {
  return [
    'Onboarding context binding',
    '',
    '  pnpm onboarding:context show --customer-slug <slug> [--root-dir <path>] [--json]',
    '  pnpm onboarding:context organization --tenant-slug <slug> --organization-id <id> [--organization-name <name>] [--intent "<request>"] [--json]',
    '  pnpm onboarding:context bind --customer-slug <slug> --tenant-slug <slug> [--organization-id <id>] [--root-dir <path>] [--apply] [--json]',
    '  pnpm onboarding:context first-work --customer-slug <slug> --intent "<request>" [--service-id <id>] [--root-dir <path>] [--apply --accept] [--bootstrap-project --project-id <id> --project-name <name> --project-summary <text>] [--json]',
    '',
    'Writes are dry-run by default. --apply is required for state changes.',
  ].join('\n');
}

function planInternalOrganization(args: ParsedArgs) {
  if (args.apply)
    throw new Error('The organization plan is read-only. Apply writes through pnpm organization.');
  const { tenantSlug, organizationId } = args;
  if (!tenantSlug || !organizationId)
    throw new Error('--tenant-slug and --organization-id are required.');
  const boundTenant = resolveIdentityContext().tenantSlug;
  if (boundTenant && boundTenant !== tenantSlug)
    throw new Error('The requested tenant does not match the current tenant scope.');
  return withExecutionContext(
    'sovereign_concierge',
    () => {
      const { profile } = resolveTenant(tenantSlug, { rootDir: args.rootDir });
      assertTenantOperational(profile, 'internal organization onboarding');
      const tier = args.tier ?? 'confidential';
      const state = loadOrganizationOperationalState(organizationId, {
        tier,
        tenantSlug,
        rootDir: args.rootDir,
      });
      if (state && (state.tenant_slug !== tenantSlug || state.tier !== tier))
        throw new Error('The organization state does not match the requested tenant and tier.');
      const scopeArgs = [
        '--tenant-slug',
        tenantSlug,
        '--organization-id',
        organizationId,
        '--tier',
        tier,
      ];
      const init = [
        'pnpm',
        'organization',
        'init',
        ...scopeArgs,
        '--name',
        args.organizationName?.trim() || profile.display_name,
        '--dry-run',
        '--json',
      ];
      const status = ['pnpm', 'organization', 'status', ...scopeArgs, '--json'];
      const firstWork =
        state?.status === 'active' && args.intent?.trim()
          ? [
              'pnpm',
              'organization',
              'work',
              'resolve',
              ...scopeArgs,
              '--intent',
              args.intent.trim(),
              '--dry-run',
              '--json',
            ]
          : undefined;
      return {
        kind: 'internal_organization_onboarding',
        tenant_slug: tenantSlug,
        organization_id: organizationId,
        tier,
        organization_status: state?.status ?? 'missing',
        next_action: {
          kind: firstWork
            ? 'preview_organization_work'
            : state
              ? 'review_organization_status'
              : 'preview_organization_init',
          ...(!args.rootDir ? { argv: firstWork ?? (state ? status : init) } : {}),
        },
      };
    },
    undefined,
    tenantSlug,
    organizationId
  );
}

export function run(args: string[] = [], print: Print = () => undefined): void {
  const parsed = parseArgs(args);
  if (parsed.command === 'help') {
    print(usage());
    return;
  }
  if (parsed.command === 'organization') {
    emit(planInternalOrganization(parsed), print);
    return;
  }
  const customerSlug = customerRequired(parsed);
  if (parsed.command === 'show') {
    emit(
      {
        kind: 'onboarding_context_status',
        customer_slug: customerSlug,
        binding: loadOnboardingContextBinding(customerSlug, parsed.rootDir),
        first_work: loadOnboardingFirstWorkRecord(customerSlug, parsed.rootDir),
      },
      print
    );
    return;
  }
  if (parsed.command === 'bind') {
    if (!parsed.tenantSlug) throw new Error('--tenant-slug is required for bind.');
    const input = {
      customerSlug,
      tenantSlug: parsed.tenantSlug,
      organizationId: parsed.organizationId,
      tier: parsed.tier,
      ownerId: parsed.ownerId,
      organizationName: parsed.organizationName,
      purpose: parsed.purpose,
      rootDir: parsed.rootDir,
    };
    const result = parsed.apply
      ? applyOnboardingContextBinding(input)
      : resolveOnboardingContext(input);
    const { binding } = result;
    emit(
      {
        ...result,
        next_action:
          result.mode === 'apply' || result.would_write.length === 0
            ? binding.tier !== 'confidential'
              ? { kind: 'review_binding_scope', tier: binding.tier }
              : {
                  kind: 'review_activation',
                  argv: [
                    'pnpm',
                    'tenant:activation',
                    'plan',
                    '--customer-slug',
                    binding.customer_slug,
                    '--tenant-slug',
                    binding.tenant_slug,
                    '--organization-id',
                    binding.organization_id,
                    ...(parsed.rootDir ? ['--root-dir', parsed.rootDir] : []),
                  ],
                }
            : {
                kind: 'review_binding',
                detail:
                  'Review the tenant, organization and planned writes before rerunning with --apply.',
              },
      },
      print
    );
    return;
  }
  if (!parsed.intent) throw new Error('--intent is required for first-work.');
  if (!parsed.apply) {
    emit(
      resolveOnboardingFirstWork({
        customerSlug,
        intent: parsed.intent,
        rootDir: parsed.rootDir,
        ...(parsed.serviceId ? { contextRefs: { service_id: parsed.serviceId } } : {}),
      }),
      print
    );
    return;
  }
  emit(
    applyOnboardingFirstWork({
      customerSlug,
      intent: parsed.intent,
      rootDir: parsed.rootDir,
      ...(parsed.serviceId ? { contextRefs: { service_id: parsed.serviceId } } : {}),
      accept: parsed.accept,
      bootstrapProject: parsed.bootstrapProject
        ? {
            projectId: parsed.projectId || '',
            name: parsed.projectName || '',
            summary: parsed.projectSummary || '',
            trackId: parsed.trackId,
            trackName: parsed.trackName,
            serviceBindings: parsed.serviceBindings,
          }
        : undefined,
    }),
    print
  );
}

export const runOnboardingContext = defineScript({
  name: 'onboarding:context',
  flags: [],
  run: ({ argv, print }) => {
    try {
      // Binding and first-work read the tenant registry (personal tier) and
      // write tenant-scoped organization state: the governed onboarding
      // authority `pnpm tenant` assumes, so no exported persona is needed.
      if (argv[0] === 'organization') run(argv, print);
      else withExecutionContext('sovereign_concierge', () => run(argv, print));
    } catch (error) {
      print(
        JSON.stringify(
          {
            error_code: 'ONBOARDING_CONTEXT_FAILED',
            message: error instanceof Error ? error.message : String(error),
            ...(error instanceof OnboardingStanceMissingError
              ? {
                  next_action: {
                    kind: 'prepare_customer_stance',
                    customer_slug: error.customerSlug,
                    detail: 'Have an authorized operator prepare this stance before retrying bind.',
                    ...(!value(argv, '--root-dir')
                      ? { argv: ['pnpm', 'stance:create', error.customerSlug] }
                      : {}),
                  },
                }
              : {}),
          },
          null,
          2
        )
      );
      throw new ScriptExitError(1);
    }
  },
});

if (
  isDirectScript(import.meta.url, 'onboarding_context.ts') ||
  isDirectScript(import.meta.url, 'onboarding_context.js')
)
  void runOnboardingContext();

export { parseArgs };
