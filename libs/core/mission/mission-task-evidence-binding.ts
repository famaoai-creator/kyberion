import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { normalizeEventScope, type EventScope } from '../event-scope.js';
import { resolveRole, withExecutionContext } from '../authority.js';
import { safeReadFileSnapshot, safeRealpath } from '../secure-io.js';
import { getWorkItem, listActiveWorkLeases } from '../workforce/work-coordination.js';
import { withCoordinationMutation } from '../workforce/work-coordination-ledger.js';
import { loadMissionNextTaskObjectsAtPath } from './mission-next-task-reader.js';
import { pathResolver } from '../path-resolver.js';
import {
  TASK_SOURCE_ROOTS,
  validateTaskSourcePaths,
} from '../foundation/task-tool-grant-validation.js';
import { listWorkspaces, workspaceOwnerScope } from '../workforce/workspace-ledger.js';

/** Trusted runtime-to-controller proof, checked at the canonical mutation boundary. */
export interface TaskEvidenceBinding {
  workItemId: string;
  leaseId: string;
  actorId: string;
  scope: EventScope;
  artifactPath?: string;
  artifactSha256?: string;
  verifiedSources?: Array<{ path: string; sha256: string }>;
}

export function parseTaskEvidenceBinding(value: unknown): TaskEvidenceBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('[TASK_EVIDENCE_BINDING_INVALID] Expected task binding');
  const input = value as Record<string, unknown>;
  for (const key of ['workItemId', 'leaseId', 'actorId'])
    if (typeof input[key] !== 'string' || !input[key] || (input[key] as string).includes('\0'))
      throw new Error('[TASK_EVIDENCE_BINDING_INVALID] Missing binding field');
  if (
    (input.artifactPath !== undefined || input.artifactSha256 !== undefined) &&
    (typeof input.artifactPath !== 'string' ||
      !input.artifactPath ||
      input.artifactPath.includes('\0') ||
      typeof input.artifactSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(input.artifactSha256))
  )
    throw new Error('[TASK_EVIDENCE_BINDING_INVALID] Invalid artifact digest');
  if (
    input.verifiedSources !== undefined &&
    (!Array.isArray(input.verifiedSources) ||
      input.verifiedSources.length > 64 ||
      input.verifiedSources.some(
        (entry: unknown) =>
          !entry ||
          typeof entry !== 'object' ||
          Array.isArray(entry) ||
          typeof (entry as Record<string, unknown>).path !== 'string' ||
          !/^[a-f0-9]{64}$/.test(String((entry as Record<string, unknown>).sha256))
      ))
  )
    throw new Error('[TASK_EVIDENCE_BINDING_INVALID] Invalid source proof');
  const scope = normalizeEventScope(input.scope as EventScope);
  if (!scope.mission_id || !scope.task_id)
    throw new Error('[TASK_EVIDENCE_BINDING_INVALID] Mission and task required');
  return {
    workItemId: input.workItemId as string,
    leaseId: input.leaseId as string,
    actorId: input.actorId as string,
    artifactPath: input.artifactPath as string,
    artifactSha256: input.artifactSha256 as string,
    verifiedSources: input.verifiedSources as TaskEvidenceBinding['verifiedSources'],
    scope,
  };
}

/** Lock order: mission -> coordination. Callback is synchronous; never hold over git/await. */
export function withTaskEvidenceFence<T>(
  proof: TaskEvidenceBinding | undefined,
  expected: {
    missionId: string;
    taskId: string;
    actorId?: string;
    missionPath: string;
    tier: string;
    tenantSlug?: string;
    status?: string;
  },
  mutate: (verified: { sourceTarget?: string }) => T
): T {
  if (!proof) return mutate({});
  const binding = parseTaskEvidenceBinding(proof);
  const role = resolveRole();
  if (!role) throw new Error('[TASK_EVIDENCE_BINDING_INVALID] Caller authority required');
  return withCoordinationMutation(() =>
    withExecutionContext(role, () => {
      const item = getWorkItem(binding.workItemId);
      const lease = listActiveWorkLeases().find((entry) => entry.lease_id === binding.leaseId);
      if (
        expected.status !== 'active' ||
        !item ||
        item.status !== 'in_progress' ||
        item.lease_id !== binding.leaseId ||
        item.claimed_by_peer_id !== binding.actorId ||
        !lease ||
        lease.status !== 'active' ||
        lease.item_id !== binding.workItemId ||
        lease.holder_peer_id !== binding.actorId ||
        !Number.isFinite(Date.parse(lease.expires_at)) ||
        Date.parse(lease.expires_at) <= Date.now()
      )
        throw new Error('[TASK_EVIDENCE_LEASE_LOST] Current claim required at evidence commit');
      if (
        binding.actorId !== expected.actorId ||
        binding.scope.mission_id !== expected.missionId ||
        binding.scope.task_id !== expected.taskId ||
        binding.scope.tier !== expected.tier ||
        (binding.scope.tenant_slug ?? '') !== (expected.tenantSlug ?? '')
      )
        throw new Error('[TASK_EVIDENCE_SCOPE_DENIED] Binding differs from evidence target');
      for (const key of [
        'mission_id',
        'task_id',
        'tenant_slug',
        'organization_id',
        'project_id',
      ] as const) {
        const actual =
          key === 'project_id' &&
          !binding.scope.project_id &&
          item.context?.project_id === expected.missionId
            ? undefined
            : item.context?.[key];
        if ((actual ?? '') !== (binding.scope[key] ?? ''))
          throw new Error('[TASK_EVIDENCE_SCOPE_DENIED] WorkItem scope changed');
      }
      const task = loadMissionNextTaskObjectsAtPath(
        path.join(expected.missionPath, 'NEXT_TASKS.json'),
        expected.missionId
      )?.find((entry) => entry.task_id === expected.taskId);
      if (!task) throw new Error('[TASK_EVIDENCE_OUTPUT_CHANGED] Task contract missing');
      const target = typeof task.target_path === 'string' ? task.target_path : undefined;
      const sourceTarget =
        target && TASK_SOURCE_ROOTS.some((prefix) => target.startsWith(prefix))
          ? target
          : undefined;
      const declaredOutput =
        typeof task.deliverable === 'string' ? task.deliverable : sourceTarget ? undefined : target;
      if (declaredOutput !== binding.artifactPath)
        throw new Error('[TASK_EVIDENCE_OUTPUT_CHANGED] Declared output changed');
      if (declaredOutput) {
        const artifact = path.resolve(expected.missionPath, declaredOutput);
        if (
          !artifact.startsWith(path.resolve(expected.missionPath) + path.sep) ||
          !safeRealpath(artifact).startsWith(safeRealpath(expected.missionPath) + path.sep) ||
          createHash('sha256').update(safeReadFileSnapshot(artifact, 1_048_576)).digest('hex') !==
            binding.artifactSha256
        )
          throw new Error('[TASK_EVIDENCE_OUTPUT_CHANGED] Verified output changed');
      }
      const sources = validateTaskSourcePaths(task.source_edit_paths ?? []);
      if (sourceTarget && !sources.includes(sourceTarget))
        sources.push(...validateTaskSourcePaths([sourceTarget]));
      const proofs = binding.verifiedSources ?? [];
      const seen = new Set<string>();
      for (const proof of proofs) {
        if (!sources.includes(proof.path) || seen.has(proof.path))
          throw new Error('[TASK_EVIDENCE_OUTPUT_CHANGED] Source is outside canonical grant');
        seen.add(proof.path);
        const source = path.resolve(pathResolver.rootDir(), proof.path);
        if (TASK_SOURCE_ROOTS.some((prefix) => proof.path.startsWith(prefix))) {
          if (binding.scope.tier !== 'public')
            throw new Error('[TASK_EVIDENCE_SCOPE_DENIED] Private source declassification denied');
        } else {
          const workspace = listWorkspaces().find(
            (record) =>
              record.live &&
              record.owner.mission_id === expected.missionId &&
              record.owner.task_id === expected.taskId &&
              source.startsWith(path.resolve(record.path) + path.sep)
          );
          const owner = workspace && workspaceOwnerScope(workspace.owner);
          if (
            !workspace ||
            !owner ||
            owner.tier !== binding.scope.tier ||
            owner.tenant !== (binding.scope.tenant_slug ?? 'shared') ||
            (owner.organization_id ?? '') !== (binding.scope.organization_id ?? '') ||
            (owner.project_id ?? '') !== (binding.scope.project_id ?? '')
          )
            throw new Error('[TASK_EVIDENCE_SCOPE_DENIED] Source workspace ownership changed');
        }
        if (
          !safeRealpath(source).startsWith(safeRealpath(pathResolver.rootDir()) + path.sep) ||
          createHash('sha256').update(safeReadFileSnapshot(source, 1_048_576)).digest('hex') !==
            proof.sha256
        )
          throw new Error('[TASK_EVIDENCE_OUTPUT_CHANGED] Verified source changed');
      }
      if ((sources.length && !proofs.length) || (sourceTarget && !seen.has(sourceTarget)))
        throw new Error('[TASK_EVIDENCE_OUTPUT_REQUIRED] Verified source target required');
      if (!declaredOutput && !sourceTarget)
        throw new Error(
          '[TASK_EVIDENCE_OUTPUT_REQUIRED] Task must declare a verifiable deliverable or source target'
        );
      return mutate({ sourceTarget: !declaredOutput ? sourceTarget : undefined });
    })
  );
}
