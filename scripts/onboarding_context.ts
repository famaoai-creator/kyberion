#!/usr/bin/env node
import * as path from 'node:path';
import {
  applyOnboardingContextBinding,
  applyOnboardingFirstWork,
  loadOnboardingContextBinding,
  loadOnboardingFirstWorkRecord,
  resolveOnboardingContext,
  resolveOnboardingFirstWork,
} from '@agent/core/onboarding-context';
import * as customerResolver from '@agent/core/customer-resolver';
import type { OrganizationTier } from '@agent/core/organization-operating-model';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

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
  const subcommand = argv.includes('first-work')
    ? 'first-work'
    : argv.includes('bind')
      ? 'bind'
      : 'show';
  return {
    command: subcommand,
    rootDir: value(argv, '--root-dir') ? path.resolve(value(argv, '--root-dir')!) : undefined,
    customerSlug: value(argv, '--customer-slug') || customerResolver.activeCustomer() || undefined,
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
    '  pnpm onboarding:context bind --customer-slug <slug> --tenant-slug <slug> [--organization-id <id>] [--root-dir <path>] [--apply] [--json]',
    '  pnpm onboarding:context first-work --customer-slug <slug> --intent "<request>" [--service-id <id>] [--root-dir <path>] [--apply --accept] [--bootstrap-project --project-id <id> --project-name <name> --project-summary <text>] [--json]',
    '',
    'Writes are dry-run by default. --apply is required for state changes.',
  ].join('\n');
}

export function run(args: string[] = [], print: Print = () => undefined): void {
  const parsed = parseArgs(args);
  if (parsed.command === 'help') {
    print(usage());
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
    emit(
      parsed.apply ? applyOnboardingContextBinding(input) : resolveOnboardingContext(input),
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
      run(argv, print);
    } catch (error) {
      print(
        JSON.stringify(
          {
            error_code: 'ONBOARDING_CONTEXT_FAILED',
            message: error instanceof Error ? error.message : String(error),
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
