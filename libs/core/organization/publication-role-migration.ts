/** Explicit, additive installation upgrade for the PR host's narrow IO roles. */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { pathResolver } from '../path-resolver.js';
import { defineCatalog } from '../foundation/governed-catalog.js';
import { withLockSync } from '../foundation/lock-utils.js';
import { parseSafeJsonObjectInput } from '../foundation/safe-json.js';
import { auditChain } from '../governance/audit-chain.js';
import {
  assertApprovalUsable,
  claimApprovalApply,
  computeApprovalPayloadHash,
  createApprovalRequest,
  isApprovalRequestExpired,
  listApprovalRequests,
  loadApprovalRequest,
  recordApprovalApplyResult,
} from '../governance/approval-store.js';
import { nowIso } from '../foundation/time.js';
import { resolvePromotionTargetRoot } from '../knowledge/memory-promotion-git.js';
import { writeScopedArtifact } from '../workforce/artifact-store.js';
import { resolveScopeContext, withScopeEnvOnly } from '../scope-context.js';
import { currentScopeEnvelope } from '../scope-envelope.js';
import { currentExecutionScope } from '../foundation/execution-scope.js';
import { currentResourceAccessScope } from '../foundation/resource-access-scope.js';
import { getRegisteredEnvText } from '../foundation/env.js';
import { hasDelegatedExecutionContext } from '../governance/delegated-execution.js';
import { hasHumanExecutionContext } from '../governance/human-execution.js';
import { hasExternalOperationAuthority } from '../governance/external-operation.js';
import { getPluginExecutionContext } from '../shell/sandbox-policy.js';
import {
  safeExecResult,
  safeExistsSync,
  safeReadFile,
  safeReaddir,
  safeWriteFile,
} from '../secure-io.js';

export const PUBLICATION_MIGRATION_ROLES = [
  'notification_preferences_reader',
  'tool_runtime_policy_reader',
  'person_charter_store',
  'pr_publication_store',
] as const;
const GOVERNANCE = 'knowledge/product/governance/';
const CATALOGS = [
  'security-policy.json',
  'authority-role-index.json',
  'role-assumption-policy.json',
];
const SOURCE_PATHS = [
  ...CATALOGS.map((name) => GOVERNANCE + name),
  ...PUBLICATION_MIGRATION_ROLES.map((role) => `${GOVERNANCE}authority-roles/${role}.json`),
];
type JsonObject = Record<string, unknown>;
export interface PublicationRoleMigrationChange {
  path: string;
  beforeSha256: string | null;
  afterSha256: string;
  before: string | null;
  after: string;
}
export interface PublicationRoleMigrationPlan {
  sourceRoot: string;
  targetRoot: string;
  roles: readonly string[];
  digest: string;
  requestedEffect: string;
  changes: PublicationRoleMigrationChange[];
}
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`[PUBLICATION_ROLE_MIGRATION] ${label} must be an object`);
  return value as JsonObject;
}
function validateCatalog(name: string, value: unknown, sourceRoot: string): void {
  const schema = name.startsWith('authority-roles/')
    ? 'authority-role'
    : name.replace(/\.json$/, '');
  defineCatalog({
    id: `publication-migration-${schema}`,
    path: name,
    schema: path.join(sourceRoot, 'knowledge/product/schemas', `${schema}.schema.json`),
  }).validate(value);
}
// All requested paths are constants. The child uses the same secure-io guards
// under the source root; no foreign-worktree read bypass is introduced.
const READ_SOURCE = `
let input = ''; for await (const chunk of process.stdin) input += chunk;
const payload = JSON.parse(input);
const { withExecutionContext } = await import(payload.coreUrl + 'authority.js');
const { safeReadFile } = await import(payload.coreUrl + 'secure-io.js');
const { pathResolver } = await import(payload.coreUrl + 'path-resolver.js');
if (pathResolver.rootDir() !== payload.root) throw new Error('migration source root mismatch');
const result = withExecutionContext('ecosystem_architect', () => Object.fromEntries(payload.paths.map(p => [p, safeReadFile(pathResolver.rootResolve(p), { encoding: 'utf8' }).toString()])));
process.stdout.write('PUBLICATION_ROLE_SOURCE:' + JSON.stringify(result) + '\\n');
`;
function readSource(sourceRoot: string): Record<string, string> {
  const resolved = resolvePromotionTargetRoot(sourceRoot);
  if (resolved.root !== path.resolve(sourceRoot))
    throw new Error('[PUBLICATION_ROLE_MIGRATION] source must be a worktree root');
  const result = safeExecResult(process.execPath, ['--input-type=module', '-e', READ_SOURCE], {
    cwd: resolved.root,
    env: { KYBERION_ROOT: resolved.root },
    input: JSON.stringify({
      root: resolved.root,
      paths: SOURCE_PATHS,
      coreUrl: pathToFileURL(path.join(resolved.root, 'libs/core/dist/')).href,
    }),
  });
  const line = result.stdout
    .split(/\r?\n/)
    .find((entry) => entry.startsWith('PUBLICATION_ROLE_SOURCE:'));
  if (result.status !== 0 || !line)
    throw new Error(
      '[PUBLICATION_ROLE_MIGRATION] source catalog read failed; build the source worktree first'
    );
  return parseSafeJsonObjectInput(
    line.slice('PUBLICATION_ROLE_SOURCE:'.length),
    'publication role source'
  ) as Record<string, string>;
}
function hasDeny(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(
    ([key, child]) =>
      (/deny/i.test(key) && (!Array.isArray(child) || child.length > 0)) || hasDeny(child)
  );
}
/** Installation maintenance ignores saved UI selection, never a live ceiling. */
function withInstallationMigrationScope<T>(action: () => T): T {
  const execution = currentExecutionScope();
  if (
    currentScopeEnvelope() ||
    currentResourceAccessScope() ||
    execution?.tenantBound ||
    execution?.organizationId ||
    hasDelegatedExecutionContext() ||
    hasHumanExecutionContext() ||
    hasExternalOperationAuthority() ||
    getPluginExecutionContext() ||
    getRegisteredEnvText('KYBERION_SUDO') ||
    getRegisteredEnvText('KYBERION_SUDO_SCOPE')
  )
    throw new Error(
      '[PUBLICATION_ROLE_MIGRATION] a bound execution cannot widen into installation maintenance'
    );
  return withScopeEnvOnly(() => {
    const scope = resolveScopeContext();
    if (
      scope.tenant_slug ||
      scope.organization_id ||
      scope.project_id ||
      scope.mission_id ||
      scope.task_id
    )
      throw new Error(
        '[PUBLICATION_ROLE_MIGRATION] installation maintenance requires an unscoped operator process'
      );
    return action();
  });
}
/** Preview is read-only. Existing entries must agree exactly, including empty grants. */
export function previewPublicationRoleMigration(sourceRoot: string): PublicationRoleMigrationPlan {
  return withInstallationMigrationScope(() => previewPublicationRoleMigrationInScope(sourceRoot));
}
function previewPublicationRoleMigrationInScope(sourceRoot: string): PublicationRoleMigrationPlan {
  const targetRoot = pathResolver.rootDir();
  const roleDirectory = path.join(targetRoot, GOVERNANCE, 'authority-roles');
  if (
    !safeExistsSync(roleDirectory) ||
    !safeReaddir(roleDirectory).some((name) => name.endsWith('.json'))
  )
    throw new Error(
      '[PUBLICATION_ROLE_MIGRATION] initialize the canonical role directory first; adding only dependency cards would hide index-only roles'
    );
  const source = readSource(sourceRoot);
  const sourceCatalogs: Record<string, JsonObject> = {};
  const targetCatalogs: Record<string, JsonObject> = {};
  const originals: Record<string, string | null> = {};
  for (const name of CATALOGS) {
    const relative = GOVERNANCE + name;
    sourceCatalogs[name] = parseSafeJsonObjectInput(source[relative], relative);
    // Validate with the executing installation's schemas, never the source's
    // arbitrary schema bytes. A migration is not a schema installation.
    validateCatalog(name, sourceCatalogs[name], targetRoot);
    const raw = safeReadFile(path.join(targetRoot, relative), { encoding: 'utf8' }).toString();
    originals[relative] = raw;
    targetCatalogs[name] = parseSafeJsonObjectInput(raw, relative);
    validateCatalog(name, targetCatalogs[name], targetRoot);
  }
  const sourcePermissions = object(
    sourceCatalogs['security-policy.json'].authority_role_permissions,
    'source role permissions'
  );
  const targetPermissions = object(
    targetCatalogs['security-policy.json'].authority_role_permissions,
    'target role permissions'
  );
  const sourceIndex = object(
    sourceCatalogs['authority-role-index.json'].authority_roles,
    'source role index'
  );
  const targetIndex = object(
    targetCatalogs['authority-role-index.json'].authority_roles,
    'target role index'
  );
  const sourceShared = object(
    sourceCatalogs['role-assumption-policy.json'].shared_core_roles,
    'source shared core roles'
  ).roles;
  const targetShared = object(
    targetCatalogs['role-assumption-policy.json'].shared_core_roles,
    'target shared core roles'
  ).roles;
  if (!Array.isArray(sourceShared) || !Array.isArray(targetShared))
    throw new Error('[PUBLICATION_ROLE_MIGRATION] shared core role catalog is missing');
  const changes: PublicationRoleMigrationChange[] = [];
  function change(relative: string, before: string | null, after: string): void {
    if (before === after) return;
    changes.push({
      path: relative,
      beforeSha256: before === null ? null : hash(before),
      afterSha256: hash(after),
      before,
      after,
    });
  }
  function addExact(destination: JsonObject, key: string, expected: unknown): void {
    if (Object.hasOwn(destination, key) && stable(destination[key]) !== stable(expected))
      throw new Error(
        `[PUBLICATION_ROLE_MIGRATION] divergent or explicitly denied definition: ${key}`
      );
    destination[key] = expected;
  }
  for (const role of PUBLICATION_MIGRATION_ROLES) {
    const relative = `${GOVERNANCE}authority-roles/${role}.json`;
    const card = parseSafeJsonObjectInput(source[relative], relative);
    validateCatalog(`authority-roles/${role}.json`, card, targetRoot);
    if (
      card.role !== role ||
      !sourceShared.includes(role) ||
      !sourcePermissions[role] ||
      !sourceIndex[role]
    )
      throw new Error(`[PUBLICATION_ROLE_MIGRATION] incomplete source role: ${role}`);
    if (hasDeny(sourcePermissions[role]) || hasDeny(targetPermissions[role]))
      throw new Error(
        `[PUBLICATION_ROLE_MIGRATION] explicit deny requires separate policy review: ${role}`
      );
    const indexed = { ...object(sourceIndex[role], role) };
    delete indexed.role;
    const cardRecord = { ...card };
    delete cardRecord.role;
    if (stable(indexed) !== stable(cardRecord))
      throw new Error(`[PUBLICATION_ROLE_MIGRATION] source index/card mismatch: ${role}`);
    addExact(targetPermissions, role, sourcePermissions[role]);
    addExact(targetIndex, role, sourceIndex[role]);
    const destination = path.join(targetRoot, relative);
    const before = safeExistsSync(destination)
      ? safeReadFile(destination, { encoding: 'utf8' }).toString()
      : null;
    if (before !== null && stable(parseSafeJsonObjectInput(before, relative)) !== stable(card))
      throw new Error(`[PUBLICATION_ROLE_MIGRATION] divergent role card: ${role}`);
    if (before === null) change(relative, null, `${JSON.stringify(card, null, 2)}\n`);
    if (!targetShared.includes(role)) targetShared.push(role);
  }
  for (const name of CATALOGS) {
    const relative = GOVERNANCE + name;
    validateCatalog(name, targetCatalogs[name], targetRoot);
    // Preserve original bytes when there is no semantic delta.
    if (
      stable(parseSafeJsonObjectInput(originals[relative]!, relative)) !==
      stable(targetCatalogs[name])
    )
      change(relative, originals[relative], `${JSON.stringify(targetCatalogs[name], null, 2)}\n`);
  }
  const digest = hash(
    stable({
      targetRoot,
      sourceRoot: path.resolve(sourceRoot),
      changes: changes.map(({ path: file, beforeSha256, afterSha256 }) => ({
        path: file,
        beforeSha256,
        afterSha256,
      })),
    })
  );
  return {
    targetRoot,
    sourceRoot: path.resolve(sourceRoot),
    roles: PUBLICATION_MIGRATION_ROLES,
    digest,
    requestedEffect: `publication-role-migration:${digest}`,
    changes,
  };
}
export function applyPublicationRoleMigration(
  sourceRoot: string,
  options: { approvalId: string; expectedDigest: string }
): PublicationRoleMigrationPlan {
  return withInstallationMigrationScope(() =>
    withLockSync('installation-publication-role-migration', () => {
      const plan = previewPublicationRoleMigration(sourceRoot);
      if (plan.digest !== options.expectedDigest)
        throw new Error('[PUBLICATION_ROLE_MIGRATION] preview changed; review a fresh preview');
      if (!plan.changes.length) return plan;
      const approval = loadApprovalRequest('terminal', options.approvalId);
      if (approval?.applyClaim || approval?.applyResult || approval?.consumption)
        throw new Error(
          '[PUBLICATION_ROLE_MIGRATION] approval application already started; inspect the canonical receipt and request a fresh human review'
        );
      const effects = approval?.justification?.requestedEffects || [];
      if (
        !approval ||
        approval.status !== 'approved' ||
        approval.accountability?.finalDecision !== 'human_only' ||
        !approval.workflow?.approvals?.some(
          (entry) =>
            entry.status === 'approved' &&
            entry.decidedByType === 'human' &&
            entry.authenticated === true
        ) ||
        !effects.includes(plan.requestedEffect) ||
        !plan.changes.every((entry) => effects.includes(entry.path))
      )
        throw new Error(
          '[PUBLICATION_ROLE_MIGRATION] authenticated human approval must bind the exact preview digest and changed paths'
        );
      assertApprovalUsable(approval, { consumer: 'installation_publication_role_migration' });
      const metadata = {
        digest: plan.digest,
        source_root: plan.sourceRoot,
        target_root: plan.targetRoot,
        approval_id: options.approvalId,
        changes: plan.changes.map(({ path: file, beforeSha256, afterSha256 }) => ({
          path: file,
          beforeSha256,
          afterSha256,
        })),
      };
      auditChain.record({
        agentId: 'organization-role-migration',
        action: 'publication_role_migration',
        operation: plan.digest,
        result: 'allowed',
        metadata,
      });
      for (const entry of plan.changes) {
        const absolute = path.join(plan.targetRoot, entry.path);
        const current = safeExistsSync(absolute)
          ? hash(safeReadFile(absolute, { encoding: 'utf8' }).toString())
          : null;
        if (current !== entry.beforeSha256)
          throw new Error(
            '[PUBLICATION_ROLE_MIGRATION] catalog changed during apply; review fresh preview'
          );
      }
      const claimed = claimApprovalApply('infrastructure_sentinel', {
        channel: 'terminal',
        storageChannel: 'terminal',
        requestId: options.approvalId,
        appliedBy: 'organization-role-migration',
        expectedRecordHash: computeApprovalPayloadHash({ record: approval }),
        rerequestCommand: `pnpm organization role migrate-publication-store --source-root ${plan.sourceRoot} --request-approval --expected-digest ${plan.digest}`,
      });
      try {
        for (const entry of plan.changes) {
          const absolute = path.join(plan.targetRoot, entry.path);
          const current = safeExistsSync(absolute)
            ? hash(safeReadFile(absolute, { encoding: 'utf8' }).toString())
            : null;
          if (current !== entry.beforeSha256)
            throw new Error(
              '[PUBLICATION_ROLE_MIGRATION] catalog changed immediately before write; stop catalog writers and review a fresh preview'
            );
          safeWriteFile(absolute, entry.after);
        }
      } catch (error) {
        recordApprovalApplyResult('infrastructure_sentinel', {
          channel: 'terminal',
          requestId: options.approvalId,
          claimId: claimed.applyClaim.claimId,
          applyResult: {
            result: 'failed',
            appliedAt: nowIso(),
            appliedBy: 'organization-role-migration',
            auditRef: plan.digest,
          },
        });
        auditChain.record({
          agentId: 'organization-role-migration',
          action: 'publication_role_migration',
          operation: plan.digest,
          result: 'failed',
          reason: String(error),
          metadata,
        });
        throw error;
      }
      recordApprovalApplyResult('infrastructure_sentinel', {
        channel: 'terminal',
        requestId: options.approvalId,
        claimId: claimed.applyClaim.claimId,
        applyResult: {
          result: 'success',
          appliedAt: nowIso(),
          appliedBy: 'organization-role-migration',
          auditRef: plan.digest,
        },
      });
      auditChain.record({
        agentId: 'organization-role-migration',
        action: 'publication_role_migration',
        operation: plan.digest,
        result: 'completed',
        metadata,
      });
      return plan;
    })
  );
}

/** Open a human decision; this does not apply the catalog migration. */
export function requestPublicationRoleMigrationApproval(
  sourceRoot: string,
  options: { expectedDigest: string; requestedBy: string }
): {
  plan: PublicationRoleMigrationPlan;
  approvalId: string;
  reviewPath: string;
  status: 'pending_human' | 'ready_to_apply';
  reused: boolean;
} {
  return withInstallationMigrationScope(() =>
    withLockSync('installation-publication-role-migration', () => {
      const plan = previewPublicationRoleMigration(sourceRoot);
      if (plan.digest !== options.expectedDigest)
        throw new Error('[PUBLICATION_ROLE_MIGRATION] preview changed; review a fresh preview');
      if (!plan.changes.length)
        throw new Error('[PUBLICATION_ROLE_MIGRATION] no catalog change requires approval');
      const reviewRelative = `active/shared/artifacts/personal/shared/evidence/installation-publication-role-migration/${plan.digest}.json`;
      const reviewAbsolute = path.join(plan.targetRoot, reviewRelative);
      const requestedEffects = [plan.requestedEffect, ...plan.changes.map((entry) => entry.path)];
      const details = JSON.stringify(
        {
          digest: plan.digest,
          reviewPath: reviewRelative,
          changes: plan.changes.map(({ path: file, beforeSha256, afterSha256 }) => ({
            path: file,
            beforeSha256,
            afterSha256,
          })),
        },
        null,
        2
      );
      const candidates = listApprovalRequests({
        storageChannels: ['terminal'],
        status: ['pending', 'approved'],
      });
      for (const candidate of candidates) {
        if (
          !['pending', 'approved'].includes(candidate.status) ||
          isApprovalRequestExpired(candidate) ||
          candidate.revocation ||
          candidate.consumption ||
          candidate.applyClaim ||
          candidate.applyResult ||
          candidate.channel !== 'terminal' ||
          candidate.storageChannel !== 'terminal' ||
          candidate.scope !== undefined ||
          candidate.requestedBy !== options.requestedBy ||
          candidate.correlationId !== plan.requestedEffect ||
          candidate.threadTs !== plan.digest ||
          candidate.requestedByContext?.surface !== 'terminal' ||
          candidate.requestedByContext?.actorRole !== 'ecosystem_architect' ||
          candidate.requestedByContext?.actorId !== options.requestedBy ||
          candidate.accountability?.finalDecision !== 'human_only' ||
          candidate.workflow?.workflowId !== 'installation-publication-role-migration' ||
          candidate.details !== details ||
          stable(candidate.justification?.requestedEffects) !== stable(requestedEffects) ||
          stable(candidate.justification?.evidence) !== stable([reviewRelative])
        )
          continue;
        if (
          !safeExistsSync(reviewAbsolute) ||
          stable(
            parseSafeJsonObjectInput(
              safeReadFile(reviewAbsolute, { encoding: 'utf8' }).toString(),
              'migration review artifact'
            )
          ) !== stable(plan)
        )
          continue;
        if (candidate.status === 'approved') {
          if (
            !candidate.workflow.approvals.some(
              (entry) =>
                entry.status === 'approved' &&
                entry.decidedByType === 'human' &&
                entry.authenticated === true
            )
          )
            continue;
          try {
            assertApprovalUsable(candidate, {
              consumer: 'installation_publication_role_migration',
            });
          } catch {
            continue;
          }
        }
        return {
          plan,
          approvalId: candidate.id,
          reviewPath: reviewAbsolute,
          status: candidate.status === 'approved' ? 'ready_to_apply' : 'pending_human',
          reused: true,
        };
      }
      const review = writeScopedArtifact({
        scope: { tenant: 'shared' },
        tier: 'personal',
        artifact_class: 'evidence',
        name: `installation-publication-role-migration/${plan.digest}.json`,
        content: plan,
      });
      const record = createApprovalRequest('infrastructure_sentinel', {
        channel: 'terminal',
        storageChannel: 'terminal',
        threadTs: plan.digest,
        correlationId: plan.requestedEffect,
        requestedBy: options.requestedBy,
        requestedByContext: {
          surface: 'terminal',
          actorId: options.requestedBy,
          actorRole: 'ecosystem_architect',
        },
        draft: {
          title: 'PR publication installation role catalog migration',
          summary: `Approve ${plan.changes.length} additive catalog changes for ${plan.roles.join(', ')}. No PR is created by this approval.`,
          details,
          severity: 'high',
        },
        justification: {
          reason: 'Explicit installation upgrade for the reviewed PR host dependency bundle',
          evidence: [review.repo_relative_path],
          requestedEffects,
        },
        accountability: { finalDecision: 'human_only' },
        risk: { level: 'high', restartScope: 'manual', requiresStrongAuth: true },
        workflow: {
          workflowId: 'installation-publication-role-migration',
          mode: 'all_required',
          requiredRoles: ['human'],
          stages: [{ stageId: 'human', requiredRoles: ['human'] }],
          approvals: [{ role: 'human', status: 'pending' }],
        },
      });
      return {
        plan,
        approvalId: record.id,
        reviewPath: review.absolute_path,
        status: 'pending_human',
        reused: false,
      };
    })
  );
}
