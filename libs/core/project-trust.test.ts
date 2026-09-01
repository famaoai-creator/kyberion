import { describe, expect, it } from 'vitest';

import {
  approvalRequestLogicalPath,
  decideApprovalRequest,
  safeRmSync,
  safeSymlinkSync,
  safeWriteFile,
  safeUnlinkSync,
  withExecutionContext,
} from './index.js';
import { pathResolver } from './path-resolver.js';
import {
  assertProjectTrustApproval,
  createProjectTrustApprovalRequest,
  PROJECT_TRUST_APPROVAL_CHANNEL,
} from './project-trust.js';

describe('project trust approvals', () => {
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
});
