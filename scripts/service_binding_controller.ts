import { randomUUID } from 'node:crypto';
import { nowIso } from '@agent/core/foundation';
import {
  listServiceBindingRecords,
  saveServiceBindingRecord,
  type ServiceBindingRecord,
} from '@agent/core/service/service-binding-registry';
import { resolveTenant } from '@agent/core/organization/tenant-registry';
import { getServicePresetRecord } from '@agent/core/service/service-preset-registry';
import { defineScript, isDirectScript } from './lib/harness.js';

type Print = (value: unknown) => void;

function value(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  const item = argv[index + 1];
  return index >= 0 && item && !item.startsWith('--') ? item : undefined;
}

function required(argv: string[], name: string): string {
  const item = value(argv, name);
  if (!item) throw new Error(`${name} is required`);
  return item;
}

function csv(argv: string[], name: string): string[] {
  const raw = required(argv, name);
  const values = [
    ...new Set(
      raw
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    ),
  ];
  if (!values.length) throw new Error(`${name} must contain at least one value`);
  return values;
}

function help(): string {
  return `Service binding controller\n\nCommands:\n  list --tenant <slug> [--json]\n  create --tenant <slug> --service <service-id> --binding-id <ID> --target <TEXT> --actions <CSV> [--secrets <CSV>] [--approval <allowed|approval_required|denied>] [--json]\n\nCreates an organization-owned tenant binding. Secret values are never accepted. This command does not provision tenant-isolated credentials; see the service integration guide for the current secret-resolution boundary.`;
}

export async function main(argv: string[], print: Print = console.log): Promise<void> {
  const [command, ...args] = argv;
  if (!command || command === 'help' || command === '--help') {
    print(help());
    return;
  }
  if (command === 'list') {
    const tenant = required(args, '--tenant');
    resolveTenant(tenant);
    const records = listServiceBindingRecords().filter(
      (record) => record.owner_kind === 'organization' && record.tenant_slug === tenant
    );
    print(
      args.includes('--json')
        ? JSON.stringify(records, null, 2)
        : records
            .map(
              (r) =>
                `${r.binding_id}\t${r.service_id ?? r.service_type}\t${r.allowed_actions.join(',')}`
            )
            .join('\n')
    );
    return;
  }
  if (command !== 'create')
    throw new Error(`Unknown service binding command: ${command}\n${help()}`);

  const tenant = required(args, '--tenant');
  resolveTenant(tenant);
  const serviceId = required(args, '--service');
  const preset = getServicePresetRecord(serviceId);
  if (!preset)
    throw new Error(`Service '${serviceId}' is not registered in the endpoint/preset catalogs`);
  const actions = csv(args, '--actions');
  for (const action of actions) {
    if (!Object.hasOwn(preset.operations, action)) {
      throw new Error(`Action '${action}' is not declared by the '${serviceId}' service preset`);
    }
  }
  const approval = value(args, '--approval') ?? 'approval_required';
  if (!['allowed', 'approval_required', 'denied'].includes(approval)) {
    throw new Error('--approval must be allowed, approval_required, or denied');
  }
  const bindingId = required(args, '--binding-id');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,99}$/.test(bindingId)) {
    throw new Error('--binding-id must be 2-100 letters, numbers, dots, underscores, or hyphens');
  }
  if (listServiceBindingRecords().some((record) => record.binding_id === bindingId)) {
    throw new Error(`Binding '${bindingId}' already exists`);
  }
  const record: ServiceBindingRecord = {
    binding_id: bindingId,
    service_type: serviceId,
    service_id: serviceId,
    scope: `tenant:${tenant}`,
    target: required(args, '--target'),
    allowed_actions: actions,
    secret_refs:
      value(args, '--secrets')
        ?.split(',')
        .map((item) => item.trim())
        .filter(Boolean) ?? [],
    approval_policy: Object.fromEntries(
      actions.map((action) => [action, approval as ServiceBindingRecord['approval_policy'][string]])
    ),
    tenant_slug: tenant,
    owner_kind: 'organization',
    owner_ref: tenant,
    auth_mode: 'secret-guard',
    metadata: {
      created_at: nowIso(),
      created_by: 'service-binding-controller',
      request_id: randomUUID(),
    },
  };
  saveServiceBindingRecord(record);
  print(
    args.includes('--json')
      ? JSON.stringify(record, null, 2)
      : `Created ${bindingId} for tenant ${tenant} (${serviceId}: ${actions.join(', ')})`
  );
}

if (
  isDirectScript(import.meta.url, 'service_binding_controller.ts') ||
  isDirectScript(import.meta.url, 'service_binding_controller.js')
) {
  defineScript({
    name: 'service-binding-controller',
    run: ({ argv, print }) => main(argv, print),
  });
}
