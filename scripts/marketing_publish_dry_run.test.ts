import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  pathResolver,
  buildPublicationEffectPayload,
  computeApprovalPayloadHash,
  createApprovalRequest,
  decideApprovalRequest,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
  sha256,
  type PublicationApproval,
  type ApprovalRequestRecord,
  withExecutionContext,
} from '@agent/core';
import { runMarketingPublishDryRun } from './marketing_publish_dry_run.js';

const roots: string[] = [];

function fixture(): {
  root: string;
  approvalPath: string;
  videoPath: string;
  sharedApprovalRequest: ApprovalRequestRecord;
} {
  const relativeRoot = `active/shared/tmp/marketing-publish-tests/${randomUUID()}`;
  const root = pathResolver.rootResolve(relativeRoot);
  roots.push(root);
  safeMkdir(root, { recursive: true });
  const videoPath = path.join(root, 'video.mp4');
  const captionsPath = path.join(root, 'captions.vtt');
  const thumbnailPath = path.join(root, 'thumbnail.png');
  safeWriteFile(videoPath, 'video-v1');
  safeWriteFile(captionsPath, 'WEBVTT');
  safeWriteFile(thumbnailPath, 'png');
  const bind = (filePath: string) => ({
    path: path.relative(pathResolver.rootDir(), filePath),
    sha256: sha256(safeReadFile(filePath) as Buffer),
  });
  const approval: PublicationApproval = {
    approval_id: 'approval-test-001',
    mission_id: 'mission-test-001',
    approved_artifacts: {
      video: bind(videoPath),
      captions: bind(captionsPath),
      thumbnail: bind(thumbnailPath),
    },
    destination: { service: 'youtube', account: 'official', visibility: 'unlisted' },
    title: 'Governed preview',
    description: 'Dry-run publication preview',
    cta_url: 'https://example.com/cta',
    approved_by: ['human:owner'],
    approval_decisions: [
      {
        approved_by: 'human:owner',
        decided_by_type: 'human',
        authenticated: true,
        approved_at: '2026-07-12T00:00:00.000Z',
      },
    ],
    approved_at: '2026-07-12T00:00:00.000Z',
    expires_at: '2099-07-13T00:00:00.000Z',
    risk_level: 2,
    review_ids: ['review-001'],
    shared_approval: {
      storage_channel: 'terminal',
      request_id: '00000000-0000-4000-8000-000000000001',
      payload_hash: '',
      effect_binding: 'marketing-publication:mission-test-001',
    },
  };
  approval.shared_approval.payload_hash = computeApprovalPayloadHash(
    buildPublicationEffectPayload(approval)
  );
  const sharedApprovalRequest: ApprovalRequestRecord = {
    id: approval.shared_approval.request_id,
    kind: 'channel-approval',
    storageChannel: 'terminal',
    channel: 'terminal',
    threadTs: 'thread-1',
    correlationId: 'correlation-1',
    requestedBy: 'distribution-role',
    requestedAt: '2026-07-12T00:00:00.000Z',
    status: 'approved',
    title: 'Approve marketing publication dry-run',
    summary: 'Bound publication effect',
    accountability: {
      finalDecision: 'human_only',
      payloadHash: approval.shared_approval.payload_hash,
      effectBinding: approval.shared_approval.effect_binding,
    },
    workflow: {
      workflowId: 'marketing-publication',
      mode: 'all_required',
      requiredRoles: ['marketing-owner'],
      stages: [],
      approvals: [
        {
          role: 'marketing-owner',
          status: 'approved',
          approvedBy: 'human:owner',
          approvedAt: '2026-07-12T00:00:00.000Z',
          decidedByType: 'human',
          authenticated: true,
          payloadHash: approval.shared_approval.payload_hash,
          effectBinding: approval.shared_approval.effect_binding,
        },
      ],
    },
  };
  const approvalPath = path.join(root, 'approval.json');
  safeWriteFile(approvalPath, JSON.stringify(approval, null, 2));
  return { root, approvalPath, videoPath, sharedApprovalRequest };
}

afterEach(() => {
  for (const root of roots.splice(0)) safeRmSync(root, { recursive: true, force: true });
});

describe('marketing publication dry-run', () => {
  it('re-hashes approved artifacts and writes local preview verification', () => {
    const { root, approvalPath, sharedApprovalRequest } = fixture();
    const result = runMarketingPublishDryRun({
      approvalPath,
      outputRoot: path.join(root, 'output'),
      sharedApprovalRequest,
    });
    expect(result.status).toBe('dry_run_completed');
    expect(safeExistsSync(result.preview)).toBe(true);
    const verification = JSON.parse(
      safeReadFile(result.verification, { encoding: 'utf8' }) as string
    );
    expect(verification).toMatchObject({
      gate_id: 'G6',
      status: 'passed',
      approval_id: 'approval-test-001',
      network_access: false,
      counts_as_publication: false,
    });
  });

  it('rejects an artifact changed after approval', () => {
    const { root, approvalPath, videoPath, sharedApprovalRequest } = fixture();
    safeWriteFile(videoPath, 'video-v2');
    expect(() =>
      runMarketingPublishDryRun({
        approvalPath,
        outputRoot: path.join(root, 'output'),
        sharedApprovalRequest,
      })
    ).toThrow('artifact binding changed: video');
  });

  it('rejects unauthenticated or expired approval', () => {
    const { root, approvalPath, sharedApprovalRequest } = fixture();
    const approval = JSON.parse(
      safeReadFile(approvalPath, { encoding: 'utf8' }) as string
    ) as PublicationApproval;
    approval.approval_decisions = [];
    approval.expires_at = '2020-01-01T00:00:00.000Z';
    safeWriteFile(approvalPath, JSON.stringify(approval));
    expect(() =>
      runMarketingPublishDryRun({
        approvalPath,
        outputRoot: path.join(root, 'output'),
        sharedApprovalRequest,
      })
    ).toThrow('approval has expired');
  });

  it('rejects PII in approved publication text without logging the raw value', () => {
    const { root, approvalPath, sharedApprovalRequest } = fixture();
    const approval = JSON.parse(
      safeReadFile(approvalPath, { encoding: 'utf8' }) as string
    ) as PublicationApproval;
    approval.description = 'Contact alice@example.com';
    safeWriteFile(approvalPath, JSON.stringify(approval));
    expect(() =>
      runMarketingPublishDryRun({
        approvalPath,
        outputRoot: path.join(root, 'output'),
        sharedApprovalRequest,
      })
    ).toThrow('Publication classification denied: 1 PII finding(s), 0 secret finding(s)');
  });

  it('rejects a shared approval payload binding mismatch', () => {
    const { root, approvalPath, sharedApprovalRequest } = fixture();
    sharedApprovalRequest.accountability!.payloadHash = 'b'.repeat(64);
    expect(() =>
      runMarketingPublishDryRun({
        approvalPath,
        outputRoot: path.join(root, 'output'),
        sharedApprovalRequest,
      })
    ).toThrow('shared approval accountability payload hash changed');
  });

  it('loads an authenticated human decision from the shared approval store', () => {
    const input = fixture();
    const storageChannel = `marketing-${randomUUID().slice(0, 8)}`;
    const approval = JSON.parse(
      safeReadFile(input.approvalPath, { encoding: 'utf8' }) as string
    ) as PublicationApproval;
    const payloadHash = computeApprovalPayloadHash(buildPublicationEffectPayload(approval));
    const request = createApprovalRequest('mission_controller', {
      channel: 'terminal',
      storageChannel,
      threadTs: 'thread-store-test',
      correlationId: 'correlation-store-test',
      requestedBy: 'distribution-role',
      draft: { title: 'Approve publication', summary: 'Bound dry-run effect' },
      workflow: {
        workflowId: 'marketing-publication',
        mode: 'all_required',
        requiredRoles: ['marketing-owner'],
        stages: [],
        approvals: [{ role: 'marketing-owner', status: 'pending' }],
      },
      accountability: {
        finalDecision: 'human_only',
        payloadHash,
        effectBinding: approval.shared_approval.effect_binding,
      },
    });
    approval.shared_approval = {
      storage_channel: storageChannel,
      request_id: request.id,
      payload_hash: payloadHash,
      effect_binding: approval.shared_approval.effect_binding,
    };
    safeWriteFile(input.approvalPath, JSON.stringify(approval));
    decideApprovalRequest('mission_controller', {
      channel: 'terminal',
      storageChannel,
      requestId: request.id,
      decision: 'approved',
      decidedBy: 'human:owner',
      decidedByRole: 'marketing-owner',
      authMethod: 'manual',
      decidedByType: 'human',
      authenticated: true,
      payloadHash,
      effectBinding: approval.shared_approval.effect_binding,
    });
    const coordinationRoot = pathResolver.shared(`coordination/channels/${storageChannel}`);
    const observabilityPath = pathResolver.shared(
      `observability/channels/${storageChannel}/approvals.jsonl`
    );
    try {
      const result = runMarketingPublishDryRun({
        approvalPath: input.approvalPath,
        outputRoot: path.join(input.root, 'output'),
      });
      expect(result.status).toBe('dry_run_completed');
    } finally {
      withExecutionContext('mission_controller', () => {
        safeRmSync(coordinationRoot, { recursive: true, force: true });
        safeRmSync(observabilityPath, { force: true });
      });
    }
  });
});
