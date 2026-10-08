#!/usr/bin/env node
import * as path from 'node:path';
import {
  applyTenantActivation,
  loadTenantActivation,
  reconcileTenantActivation,
  rollbackTenantActivation,
  resolveTenantActivation,
  resumeTenantActivation,
  suspendTenantActivation,
  type TenantActivationCheck,
  type TenantActivationProbeCheck,
  type TenantActivationProbeRefs,
} from '@agent/core/organization/tenant-activation';
import { withExecutionContext, withExecutionContextAsync } from '@agent/core/authority';
import { isValidTenantSlug } from '@agent/core/foundation/scope';
import { defineScript, isDirectScript } from './lib/harness.js';

type Print = (value: unknown) => void;

function value(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  const candidate = index >= 0 ? argv[index + 1] : undefined;
  return candidate && !candidate.startsWith('--') ? candidate : undefined;
}

function required(argv: string[], name: string): string {
  const result = value(argv, name);
  if (!result) throw new Error(`${name} is required`);
  return result;
}

function probeRefs(argv: string[]): TenantActivationProbeRefs {
  const refs: TenantActivationProbeRefs = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '--probe-ref') continue;
    const value = argv[index + 1] || '';
    const separator = value.indexOf('=');
    const check = separator >= 0 ? value.slice(0, separator) : '';
    const ref = separator >= 0 ? value.slice(separator + 1).trim() : '';
    if (
      !(
        ['viewer_scope', 'nhi_provisioned', 'service_readiness', 'isolation_probe'] as const
      ).includes(check as TenantActivationProbeCheck) ||
      !ref
    ) {
      throw new Error(
        '--probe-ref must be supplied as <viewer_scope|nhi_provisioned|service_readiness|isolation_probe>=<audit-ref>'
      );
    }
    refs[check as TenantActivationProbeCheck] = ref;
    index += 1;
  }
  return refs;
}

function input(argv: string[]) {
  return {
    customerSlug: required(argv, '--customer-slug'),
    tenantSlug: required(argv, '--tenant-slug'),
    organizationId: required(argv, '--organization-id'),
    ownerId: value(argv, '--owner-id'),
    nhiIds: argv.flatMap((arg, index) =>
      arg === '--nhi-id' && argv[index + 1] ? [argv[index + 1]!] : []
    ),
    probeRefs: probeRefs(argv),
    rootDir: value(argv, '--root-dir') ? path.resolve(value(argv, '--root-dir')!) : undefined,
    checks: {
      viewer_scope: argv.includes('--check-viewer-scope'),
      nhi_provisioned: argv.includes('--check-nhi'),
      service_readiness: argv.includes('--check-services'),
      isolation_probe: argv.includes('--check-isolation'),
    } satisfies Partial<Record<TenantActivationCheck, boolean>>,
  };
}

function usage(): string {
  return [
    'Tenant activation gate',
    '',
    '  pnpm tenant:activation show --customer-slug <slug> --tenant-slug <slug> --organization-id <id>',
    '  pnpm tenant:activation plan --customer-slug <slug> --tenant-slug <slug> --organization-id <id>',
    '  pnpm tenant:activation probe --customer-slug <slug> --tenant-slug <slug> --organization-id <id> --nhi-id <nhi-id> [--service <service-id>]...',
    '  pnpm tenant:activation activate --customer-slug <slug> --tenant-slug <slug> --organization-id <id> --apply --accept',
    '  pnpm tenant:activation resume --customer-slug <slug> --tenant-slug <slug> --organization-id <id> --apply --accept',
    '  pnpm tenant:activation rollback --customer-slug <slug> --tenant-slug <slug> --organization-id <id> --reason "<why>" --apply --accept',
    '  pnpm tenant:activation reconcile --customer-slug <slug> --tenant-slug <slug> --organization-id <id>',
    '  pnpm tenant:activation suspend --customer-slug <slug> --tenant-slug <slug> --organization-id <id> --reason "<why>" --apply --accept',
    '',
    '  Explicit successful probes and audit refs are required: --check-viewer-scope --check-nhi --check-services --check-isolation',
    '  Probe refs: --probe-ref viewer_scope=<audit-ref> --probe-ref nhi_provisioned=<audit-ref> ...',
    '  `probe` runs all four checks, writes evidence beside the receipt, and prints the activate command.',
    '  A ref is either <scheme>://... (external attestation) or an existing repository path.',
  ].join('\n');
}

export function main(argv: string[] = [], print: Print = () => undefined): void | Promise<void> {
  const command = argv.find((arg) => !arg.startsWith('--')) || 'help';
  if (command === 'help') {
    print(usage());
    return;
  }
  // Activation reads the tenant registry (personal tier) and writes the receipt
  // beside the customer overlay: the governed onboarding authority, the same
  // role `pnpm tenant` assumes, so the operator needs no exported persona.
  // The facade also binds the tenant and organization it was asked about, so
  // tenant-scoped reads (organization state, probe evidence) pass a required
  // tenant binding without the operator exporting KYBERION_TENANT, and every
  // subcommand needs the same environment.
  const { tenantSlug, organizationId } = activationScope(argv);
  if (command === 'probe') {
    return withExecutionContextAsync(
      'sovereign_concierge',
      () => probe(argv, print),
      undefined,
      tenantSlug,
      organizationId
    );
  }
  withExecutionContext(
    'sovereign_concierge',
    () => dispatch(command, argv, print),
    undefined,
    tenantSlug,
    organizationId
  );
}

/** Tenant binding for the facade's execution scope, from its own --tenant-slug. */
export function activationScope(argv: string[]): {
  tenantSlug?: string;
  organizationId?: string;
} {
  const tenantSlug = value(argv, '--tenant-slug');
  if (tenantSlug !== undefined && !isValidTenantSlug(tenantSlug)) {
    throw new Error(`--tenant-slug '${tenantSlug}' is not a valid tenant slug`);
  }
  return { tenantSlug, organizationId: value(argv, '--organization-id') };
}

function dispatch(command: string, argv: string[], print: Print): void {
  if (command === 'show') {
    const activationInput = input(argv);
    print(JSON.stringify(loadTenantActivation(activationInput, activationInput.rootDir), null, 2));
    return;
  }
  const activationInput = input(argv);
  const result =
    command === 'activate' && argv.includes('--apply')
      ? applyTenantActivation({ ...activationInput, accept: argv.includes('--accept') })
      : command === 'resume' && argv.includes('--apply')
        ? resumeTenantActivation({ ...activationInput, accept: argv.includes('--accept') })
        : command === 'reconcile'
          ? reconcileTenantActivation(activationInput)
          : command === 'rollback' && argv.includes('--apply')
            ? rollbackTenantActivation({
                ...activationInput,
                reason: value(argv, '--reason') || 'operator requested rollback',
                accept: argv.includes('--accept'),
              })
            : command === 'suspend' && argv.includes('--apply')
              ? suspendTenantActivation({
                  ...activationInput,
                  reason: value(argv, '--reason') || 'operator requested suspension',
                  accept: argv.includes('--accept'),
                })
              : resolveTenantActivation(activationInput);
  print(JSON.stringify(result, null, 2));
}

async function probe(argv: string[], print: Print): Promise<void> {
  const { runTenantActivationProbes } = await import('./tenant_activation_probe.js');
  const activationInput = input(argv);
  const result = await runTenantActivationProbes({
    customerSlug: activationInput.customerSlug,
    tenantSlug: activationInput.tenantSlug,
    organizationId: activationInput.organizationId,
    nhiIds: activationInput.nhiIds,
    serviceIds: argv.flatMap((arg, index) =>
      arg === '--service' && argv[index + 1] ? [argv[index + 1]!] : []
    ),
    rootDir: activationInput.rootDir,
  });
  print(JSON.stringify(result, null, 2));
}

const script = defineScript({
  name: 'tenant:activation',
  flags: [],
  run: ({ argv, print }) => main(argv, print),
});
if (
  isDirectScript(import.meta.url, 'tenant_activation.ts') ||
  isDirectScript(import.meta.url, 'tenant_activation.js')
) {
  void script();
}
