/** Domain validation for the bounded management command contract. */
import { humanActor } from '../actor.js';
import { isValidTenantSlug } from '../entity-scope.js';
import { assertOrganizationId } from '../organization/organization-operating-model-persistence.js';
import { assertManagedProjectId } from '../project/project-management.js';
import {
  fail,
  type SurfaceManagementAuthorization,
  type SurfaceManagementCommand,
} from './surface-management-contract.js';

export function checkAuthorizationShape(auth: SurfaceManagementAuthorization): void {
  try {
    if (
      !auth ||
      !isValidTenantSlug(auth.tenantSlug) ||
      auth.actorId !== humanActor(auth.memberId).id
    )
      fail('forbidden', 403, 'A verified member and tenant are required.');
  } catch {
    fail('forbidden', 403, 'A verified member and tenant are required.');
  }
  if (
    auth.expiresAt !== undefined &&
    (typeof auth.expiresAt !== 'string' ||
      !Number.isFinite(Date.parse(auth.expiresAt)) ||
      Date.parse(auth.expiresAt) <= Date.now())
  )
    fail('expired', 403, 'The authenticated principal has expired.');
  for (const grants of [auth.allowedOrganizationIds, auth.allowedProjectIds])
    if (grants !== 'all' && (!Array.isArray(grants) || grants.some((id) => typeof id !== 'string')))
      fail('forbidden', 403, 'Entity grants are invalid.');
}
function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\u0000'))
    fail('invalid_command', 400, label + ' is invalid.');
  return value;
}
export function validate(command: SurfaceManagementCommand): void {
  if (!command || typeof command !== 'object' || Array.isArray(command))
    fail('invalid_command', 400, 'A management command is required.');
  const keys: Record<string, string[]> = {
    'organization.create': ['operation', 'requestId', 'name', 'purpose'],
    'organization.update': [
      'operation',
      'requestId',
      'organizationId',
      'expectedVersion',
      'name',
      'purpose',
    ],
    'project.create': ['operation', 'requestId', 'organizationId', 'name', 'summary'],
    'project.update': [
      'operation',
      'requestId',
      'organizationId',
      'projectId',
      'expectedVersion',
      'name',
      'summary',
    ],
  };
  const allowed = Object.hasOwn(keys, command.operation) ? keys[command.operation] : undefined;
  if (!allowed || Object.keys(command).some((key) => !allowed.includes(key)))
    fail('invalid_command', 400, 'Unsupported management fields.');
  if (
    typeof command.requestId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(command.requestId)
  )
    fail('invalid_command', 400, 'A valid idempotency requestId is required.');
  if (command.operation.endsWith('.create')) text(command.name, 'Name', 200);
  if (command.name !== undefined) text(command.name, 'Name', 200);
  if ('purpose' in command && command.purpose !== undefined)
    text(command.purpose, 'Purpose', 10000);
  if ('summary' in command && command.summary !== undefined)
    text(command.summary, 'Summary', 10000);
  if (command.operation === 'project.create') text(command.summary, 'Summary', 10000);
  try {
    if ('organizationId' in command) assertOrganizationId(command.organizationId);
    if ('projectId' in command && assertManagedProjectId(command.projectId) !== command.projectId)
      throw new Error('Non-canonical project ID');
  } catch {
    fail('invalid_command', 400, 'Entity identifiers are invalid.');
  }
  if (command.operation === 'organization.update' || command.operation === 'project.update') {
    if (!/^[a-f0-9]{64}$/.test(command.expectedVersion))
      fail('invalid_command', 400, 'A current expectedVersion is required.');
    if (
      command.name === undefined &&
      (command.operation === 'organization.update'
        ? command.purpose === undefined
        : command.summary === undefined)
    )
      fail('invalid_command', 400, 'At least one metadata field is required.');
  }
}
