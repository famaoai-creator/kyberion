/** PI-03: bind project-local pipeline execution to a durable human approval. */

import { createHash } from 'node:crypto';
import * as path from 'node:path';

import {
  computeApprovalPayloadHash,
  createApprovalRequest,
  isApprovalRequestExpired,
  listApprovalRequests,
  loadApprovalRequest,
  type ApprovalRequestRecord,
} from './approval-store.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeLstat, safeReadFile } from './secure-io.js';
import { isBuiltinPipelineResource } from './trust-requiring-resources.js';

export const PROJECT_TRUST_APPROVAL_CHANNEL = 'project-trust';

function normalizeRelativePath(inputPath: string): { absolute: string; relative: string } {
  const absolute = path.resolve(pathResolver.rootResolve(inputPath));
  const relative = path.relative(pathResolver.rootDir(), absolute).replaceAll('\\', '/');
  if (!relative || relative === '.' || relative.startsWith('../') || path.isAbsolute(relative)) {
    throw new Error('[PROJECT_TRUST_SCOPE] pipeline path must be inside the repository root');
  }
  let current = pathResolver.rootDir();
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    try {
      if (safeLstat(current).isSymbolicLink()) {
        throw new Error(
          `[PROJECT_TRUST_SCOPE] pipeline path cannot traverse a symbolic link: ${relative}`
        );
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('[PROJECT_TRUST_SCOPE]')) {
        throw error;
      }
      // Missing paths are reported by contentHash with the canonical error.
    }
  }
  return { absolute, relative };
}

function contentHash(absolutePath: string): string {
  if (!safeExistsSync(absolutePath)) {
    throw new Error(`[PROJECT_TRUST_SCOPE] pipeline resource does not exist: ${absolutePath}`);
  }
  if (!safeLstat(absolutePath).isFile()) {
    throw new Error(
      `[PROJECT_TRUST_SCOPE] pipeline resource must be a regular file: ${absolutePath}`
    );
  }
  const raw = safeReadFile(absolutePath, { encoding: 'utf8' });
  return createHash('sha256').update(String(raw)).digest('hex');
}

function effectBinding(relativePath: string): string {
  return `project-trust:${relativePath}`;
}

function bindingPayload(relativePath: string, hash: string): Record<string, string> {
  return { input_path: relativePath, content_hash: hash };
}

function isProjectTrustRequest(record: ApprovalRequestRecord, relativePath: string): boolean {
  return (
    record.storageChannel === PROJECT_TRUST_APPROVAL_CHANNEL &&
    record.requestedByContext?.actorRole === 'project-trust' &&
    record.accountability?.effectBinding === effectBinding(relativePath)
  );
}

/** Open or reuse the human approval request for one exact pipeline resource. */
export function createProjectTrustApprovalRequest(params: {
  inputPath: string;
  requestedBy?: string;
}): ApprovalRequestRecord {
  const resolved = normalizeRelativePath(params.inputPath);
  if (isBuiltinPipelineResource(resolved.relative)) {
    throw new Error(
      `[PROJECT_TRUST_NOT_REQUIRED] canonical pipeline is repository-owned: ${resolved.relative}`
    );
  }
  const hash = contentHash(resolved.absolute);
  const payload = bindingPayload(resolved.relative, hash);
  const payloadHash = computeApprovalPayloadHash(payload);
  const binding = effectBinding(resolved.relative);
  const existing = listApprovalRequests({
    storageChannels: [PROJECT_TRUST_APPROVAL_CHANNEL],
    status: ['pending', 'approved'],
  }).find(
    (record) =>
      isProjectTrustRequest(record, resolved.relative) &&
      record.accountability?.payloadHash === payloadHash
  );
  if (existing && !isApprovalRequestExpired(existing)) return existing;

  const requestedBy = params.requestedBy?.trim() || 'project-trust-cli';
  return createApprovalRequest('mission_controller', {
    channel: PROJECT_TRUST_APPROVAL_CHANNEL,
    storageChannel: PROJECT_TRUST_APPROVAL_CHANNEL,
    threadTs: binding,
    correlationId: binding,
    requestedBy,
    kind: 'channel-approval',
    draft: {
      title: `Approve project-local pipeline: ${resolved.relative}`,
      summary:
        'A project-local pipeline can change executable behavior and remains blocked until an authenticated human approves this exact content.',
      details: `Path: ${resolved.relative}\nContent SHA-256: ${hash}`,
      severity: 'high',
    },
    requestedByContext: {
      surface: 'terminal',
      actorId: requestedBy,
      actorRole: 'project-trust',
    },
    justification: {
      reason: 'Project-local executable pipeline content requires a durable human trust decision.',
      requestedEffects: [binding],
    },
    risk: { level: 'high', restartScope: 'none', requiresStrongAuth: true },
    accountability: { finalDecision: 'human_only', payloadHash, effectBinding: binding },
  });
}

/**
 * Verify an approved request before loading the resource. The hash check
 * prevents approval from surviving edits to the project-local pipeline.
 */
export function assertProjectTrustApproval(requestId: string, inputPath: string): void {
  const resolved = normalizeRelativePath(inputPath);
  if (isBuiltinPipelineResource(resolved.relative)) return;
  const record = loadApprovalRequest(PROJECT_TRUST_APPROVAL_CHANNEL, requestId);
  if (!record || !isProjectTrustRequest(record, resolved.relative)) {
    throw new Error(
      `[TRUST_REQUIRED] approved project-trust request not found for ${resolved.relative}`
    );
  }
  if (record.status !== 'approved') {
    throw new Error(
      `[TRUST_REQUIRED] project-trust request ${record.id} is ${record.status}, not approved`
    );
  }
  if (isApprovalRequestExpired(record)) {
    throw new Error(`[TRUST_REQUIRED] project-trust request ${record.id} has expired`);
  }
  if (
    record.accountability?.finalDecision !== 'human_only' ||
    record.decidedByType !== 'human' ||
    record.authenticated !== true ||
    record.decidedAuthMethod === 'local_token'
  ) {
    throw new Error(
      `[TRUST_REQUIRED] project-trust request ${record.id} lacks an authenticated human decision`
    );
  }
  const hash = contentHash(resolved.absolute);
  const expectedPayloadHash = computeApprovalPayloadHash(bindingPayload(resolved.relative, hash));
  if (record.accountability.payloadHash !== expectedPayloadHash) {
    throw new Error(
      `[TRUST_REQUIRED] project-local pipeline changed after approval: ${resolved.relative}`
    );
  }
}
