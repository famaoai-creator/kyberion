import { describe, expect, it, vi } from 'vitest';
vi.mock('../customer-resolver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../customer-resolver.js')>();
  const { customerRootWithSodOverlay } =
    await import('../governance/__tests__/sod-overlay-state.js');
  return { ...actual, customerRoot: customerRootWithSodOverlay(actual.customerRoot) };
});
import {
  clearSeparationOfDuties,
  setSeparationOfDuties,
} from '../governance/__tests__/sod-overlay.js';

import {
  approvalRequestLogicalPath,
  decideApprovalRequest,
  safeRmSync,
  safeSymlinkSync,
  safeWriteFile,
  safeUnlinkSync,
  withExecutionContext,
} from '../index.js';
import { safeMkdir } from '../secure-io.js';
import { pathResolver } from '../path-resolver.js';
import {
  assertProjectTrustApproval,
  createProjectTrustApprovalRequest,
  PROJECT_TRUST_APPROVAL_CHANNEL,
} from './project-trust.js';

describe('project trust approvals', () => {
  it('re-request opens a new request instead of reusing a self-approval that separation of duties makes unusable', () => {
    const inputPath = pathResolver.sharedTmp(`project-trust-sod-${process.pid}-${Date.now()}.json`);
    safeWriteFile(inputPath, JSON.stringify({ pipeline_id: 'project-trust-sod', steps: [] }));
    const ids: string[] = [];
    try {
      setSeparationOfDuties(false);
      const first = createProjectTrustApprovalRequest({ inputPath, requestedBy: 'trust-operator' });
      ids.push(first.id);
      decideApprovalRequest('mission_controller', {
        channel: first.channel,
        storageChannel: first.storageChannel,
        requestId: first.id,
        decision: 'approved',
        decidedBy: 'trust-operator',
        decidedByRole: 'sovereign',
        authMethod: 'manual',
        decidedByType: 'human',
        authenticated: true,
        payloadHash: first.accountability?.payloadHash,
        effectBinding: first.accountability?.effectBinding,
      });
      expect(
        createProjectTrustApprovalRequest({ inputPath, requestedBy: 'trust-operator' }).id
      ).toBe(first.id);
      setSeparationOfDuties(true);
      expect(() => assertProjectTrustApproval(first.id, inputPath)).toThrow(/Separation of duties/);
      const second = createProjectTrustApprovalRequest({
        inputPath,
        requestedBy: 'trust-operator',
      });
      ids.push(second.id);
      expect(second.id).not.toBe(first.id);
    } finally {
      clearSeparationOfDuties();
      withExecutionContext('mission_controller', () => {
        for (const id of ids) {
          safeRmSync(
            pathResolver.rootResolve(
              approvalRequestLogicalPath(PROJECT_TRUST_APPROVAL_CHANNEL, id)
            ),
            { force: true }
          );
        }
        safeRmSync(inputPath, { force: true });
      });
    }
  });

  it('requires an approved human decision and rejects content drift', () => {
    const inputPath = pathResolver.sharedTmp(`project-trust-${process.pid}-${Date.now()}.json`);
    safeWriteFile(
      inputPath,
      JSON.stringify({ pipeline_id: 'project-trust-test', steps: [{ op: 'core:if' }] })
    );
    let requestId = '';
    try {
      const request = createProjectTrustApprovalRequest({
        inputPath,
        requestedBy: 'test-operator',
      });
      requestId = request.id;
      expect(() => assertProjectTrustApproval(request.id, inputPath)).toThrow(
        '[TRUST_REQUIRED] project-trust request'
      );

      const decided = decideApprovalRequest('mission_controller', {
        channel: request.channel,
        storageChannel: request.storageChannel,
        requestId: request.id,
        decision: 'approved',
        decidedBy: 'human-operator',
        decidedByRole: 'sovereign',
        authMethod: 'manual',
        decidedByType: 'human',
        authenticated: true,
        payloadHash: request.accountability?.payloadHash,
        effectBinding: request.accountability?.effectBinding,
      });
      expect(decided.decidedByType).toBe('human');
      expect(decided.authenticated).toBe(true);
      expect(() => assertProjectTrustApproval(request.id, inputPath)).not.toThrow();

      safeWriteFile(inputPath, JSON.stringify({ pipeline_id: 'changed', steps: [] }));
      expect(() => assertProjectTrustApproval(request.id, inputPath)).toThrow(
        'project-local pipeline changed after approval'
      );
    } finally {
      withExecutionContext('mission_controller', () => {
        safeRmSync(inputPath, { force: true });
        if (requestId) {
          safeRmSync(approvalRequestLogicalPath(PROJECT_TRUST_APPROVAL_CHANNEL, requestId), {
            force: true,
          });
        }
      });
    }
  });

  it('does not create an approval request for repository-owned pipelines', () => {
    expect(() =>
      createProjectTrustApprovalRequest({ inputPath: 'pipelines/baseline-check.json' })
    ).toThrow('[PROJECT_TRUST_NOT_REQUIRED]');
  });

  it('rejects a pipeline path that traverses a symbolic link', () => {
    const targetPath = pathResolver.sharedTmp(`project-trust-target-${process.pid}.json`);
    const linkPath = pathResolver.sharedTmp(`project-trust-link-${process.pid}.json`);
    safeWriteFile(targetPath, JSON.stringify({ pipeline_id: 'symlink-target', steps: [] }));
    safeSymlinkSync(targetPath, linkPath);
    try {
      expect(() => createProjectTrustApprovalRequest({ inputPath: linkPath })).toThrow(
        'cannot traverse a symbolic link'
      );
    } finally {
      withExecutionContext('mission_controller', () => {
        safeUnlinkSync(linkPath);
        safeRmSync(targetPath, { force: true });
      });
    }
  });

  it('rejects a pipeline path replaced with a directory', () => {
    const directoryPath = pathResolver.sharedTmp(
      `project-trust-directory-${process.pid}-${Date.now()}.json`
    );
    safeMkdir(directoryPath, { recursive: true });
    try {
      expect(() => createProjectTrustApprovalRequest({ inputPath: directoryPath })).toThrow(
        'pipeline resource must be a regular file'
      );
    } finally {
      withExecutionContext('mission_controller', () => {
        safeRmSync(directoryPath, { recursive: true, force: true });
      });
    }
  });
});
