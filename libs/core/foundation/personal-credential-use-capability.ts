/** Internal claimed-person broker authority: synchronous reads of exact proof/material files only. */
import { createHash } from 'node:crypto';
import { credentialExecutionIdentity, hasTaskCredentialBinding } from './credential-binding.js';
import {
  createSynchronousResourceGrantIssuer,
  currentResourceAccessScope,
  decideResourceAccess,
} from './resource-access-scope.js';
import { registerStoreGrant } from './store-grant-registry.js';
import { isValidMemberId } from './scope.js';

export interface PersonalCredentialUseAdmission {
  readonly ownerId: string;
  readonly actorId: string;
  readonly grantId: string;
  readonly approvalId?: string;
  readonly approvalPath?: string;
  readonly accountId?: string;
  readonly generation?: string;
}
type BoundAdmission = PersonalCredentialUseAdmission & {
  readonly claim: object;
  readonly missionId: string | undefined;
  readonly taskId: string | undefined;
};
const grants = createSynchronousResourceGrantIssuer<BoundAdmission>('PERSONAL_CREDENTIAL_USE');
function current(admission: PersonalCredentialUseAdmission | BoundAdmission): boolean {
  const identity = credentialExecutionIdentity();
  return (
    !identity.tenantSlug &&
    (!('claim' in admission) ||
      (admission.claim === identity.personalClaim &&
        admission.missionId === identity.missionId &&
        admission.taskId === identity.taskId)) &&
    identity.personalClaim?.ownerId === admission.ownerId &&
    identity.personalClaim.actorId === admission.actorId
  );
}
export function withPersonalCredentialUseCapability<T>(
  admission: PersonalCredentialUseAdmission,
  run: () => T
): T {
  if (
    !hasTaskCredentialBinding() ||
    !current(admission) ||
    !admission.ownerId.startsWith('user:') ||
    !isValidMemberId(admission.ownerId.slice(5)) ||
    !/^GRT-\d{8}-[a-f0-9]{12}$/.test(admission.grantId)
  )
    throw new Error('[PERSONAL_CREDENTIAL_USE_DENIED] Exact claimed owner required');
  const files = [`active/shared/runtime/grants/personal/shared/${admission.grantId}.json`];
  if (admission.approvalId || admission.approvalPath) {
    const hash = createHash('sha256').update(admission.actorId).digest('hex');
    const suffix = `/personal/shared/owners/${hash}/grant-standing/requests/${admission.approvalId}.json`;
    const file = admission.approvalPath ?? '';
    if (
      !admission.approvalId ||
      !/^[A-Za-z0-9_-]+$/.test(admission.approvalId) ||
      !file.endsWith(suffix) ||
      file.split('/').some((p) => p === '.' || p === '..') ||
      !(
        file === `active/shared/runtime/tenant-approvals${suffix}` ||
        /^active\/shared\/runtime\/vitest-approvals(?:\/[A-Za-z0-9_-]+)*\/tenant-approvals\//.test(
          file
        )
      )
    )
      throw new Error('[PERSONAL_CREDENTIAL_USE_DENIED] Exact approval path required');
    files.push(file);
  }
  if (admission.accountId) {
    if (
      !admission.approvalId ||
      !/^[a-f0-9]{64}$/.test(admission.accountId) ||
      (admission.generation !== undefined &&
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
          admission.generation
        ))
    )
      throw new Error('[PERSONAL_CREDENTIAL_USE_DENIED] Exact approved account required');
    const directory = `knowledge/personal/connections/accounts/${admission.accountId}`;
    files.push(`${directory}/registration.json`);
    if (admission.generation) files.push(`${directory}/${admission.generation}.json`);
  } else if (admission.generation)
    throw new Error('[PERSONAL_CREDENTIAL_USE_DENIED] Account required');
  const metadata = new Set(files);
  for (const file of files) {
    const segments = file.split('/');
    while (segments.length > 1) {
      segments.pop();
      metadata.add(segments.join('/'));
    }
  }
  const identity = credentialExecutionIdentity();
  return grants.run(
    Object.freeze({
      ...admission,
      claim: identity.personalClaim!,
      missionId: identity.missionId,
      taskId: identity.taskId,
    }),
    {
      custody: { kind: 'person', ref: admission.ownerId.slice(5) },
      readExact: files,
      metadataExact: [...metadata],
      writeExact: [],
      mkdirExact: [],
      allowProductKnowledgeRead: true,
    },
    run
  );
}
export function assertPersonalCredentialUseRead(
  kind: 'grant' | 'approval' | 'account',
  id: string,
  generation?: string
): void {
  const grant = grants.resolve(currentResourceAccessScope());
  const admission = grant?.binding;
  if (
    !admission ||
    !current(admission) ||
    (kind === 'grant'
      ? admission.grantId !== id
      : kind === 'approval'
        ? admission.approvalId !== id
        : admission.accountId !== id || admission.generation !== generation)
  )
    throw new Error('[PERSONAL_CREDENTIAL_USE_DENIED] Exact live read authority required');
}
registerStoreGrant({
  id: 'personal-credential-use',
  // The approval store has a separate owner-partition preguard. Admit only
  // the addressed proof record (and metadata needed to reach that record).
  pathAllowed(target, operation) {
    const scope = currentResourceAccessScope();
    const grant = grants.resolve(scope);
    const approvalPath = grant?.binding.approvalPath;
    return Boolean(
      grant &&
      approvalPath &&
      current(grant.binding) &&
      ((target === approvalPath && (operation === 'read' || operation === 'metadata')) ||
        (operation === 'metadata' && approvalPath.startsWith(target + '/'))) &&
      decideResourceAccess(scope!, target, operation).allowed
    );
  },
  authorizes(target, operation) {
    const scope = currentResourceAccessScope();
    const grant = grants.resolve(scope);
    return Boolean(
      grant &&
      current(grant.binding) &&
      (operation === 'read' || operation === 'metadata') &&
      decideResourceAccess(scope!, target, operation).allowed &&
      !target.startsWith('knowledge/product/')
    );
  },
});
