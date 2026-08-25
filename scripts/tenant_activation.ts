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
} from '@agent/core';
import { defineScript } from './lib/harness.js';

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
    '  pnpm tenant:activation activate --customer-slug <slug> --tenant-slug <slug> --organization-id <id> --apply --accept',
    '  pnpm tenant:activation resume --customer-slug <slug> --tenant-slug <slug> --organization-id <id> --apply --accept',
    '  pnpm tenant:activation rollback --customer-slug <slug> --tenant-slug <slug> --organization-id <id> --reason "<why>" --apply --accept',
    '  pnpm tenant:activation reconcile --customer-slug <slug> --tenant-slug <slug> --organization-id <id>',
    '  pnpm tenant:activation suspend --customer-slug <slug> --tenant-slug <slug> --organization-id <id> --reason "<why>" --apply --accept',
    '',
    '  Explicit successful probes and audit refs are required: --check-viewer-scope --check-nhi --check-services --check-isolation',
    '  Probe refs: --probe-ref viewer_scope=<audit-ref> --probe-ref nhi_provisioned=<audit-ref> ...',
  ].join('\n');
}

export function main(argv: string[] = []): void {
  const command = argv.find((arg) => !arg.startsWith('--')) || 'help';
  if (command === 'help') {
    console.log(usage());
    return;
  }
  if (command === 'show') {
    const activationInput = input(argv);
    console.log(
      JSON.stringify(loadTenantActivation(activationInput, activationInput.rootDir), null, 2)
    );
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
  console.log(JSON.stringify(result, null, 2));
}

void defineScript({
  name: 'tenant:activation',
  flags: [],
  run: ({ argv }) => main(argv),
})();
