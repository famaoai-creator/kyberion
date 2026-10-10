import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `service_recording review` decides through the approval store: the review
 * request is opened at capture (requester = whoever captured), the decision is
 * subject to separation of duties and audited, and promotion re-checks the
 * approval the review points at.
 */
const identity = vi.hoisted(() => ({ displayName: 'Alice Example' }));

// Separation of duties is switched through a customer overlay of the real
// approval policy, the way an operator enables it.
const sod = vi.hoisted(() => ({ overlayPath: null as string | null, file: '' }));
vi.mock('@agent/core/customer-resolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core/customer-resolver')>();
  return {
    ...actual,
    customerRoot: (subPath = '', ...rest: unknown[]) =>
      subPath === 'policy/approval-policy.json' && sod.overlayPath
        ? sod.overlayPath
        : (actual.customerRoot as (...args: unknown[]) => string | null)(subPath, ...rest),
  };
});

vi.mock('@agent/core/organization/member-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core/organization/member-registry')>();
  return {
    ...actual,
    resolveMemberByPrincipal: (input: { source: string }) =>
      input.source === 'loopback'
        ? {
            member_id: 'owner',
            display_name: identity.displayName,
            status: 'active',
            memberships: [],
            access_registrations: [],
            created_at: '2026-10-01T00:00:00.000Z',
            updated_at: '2026-10-01T00:00:00.000Z',
          }
        : null,
  };
});

vi.mock('@agent/core/surface/operator-identity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core/surface/operator-identity')>();
  return { ...actual, resolveOperatorDisplayName: () => identity.displayName };
});

import { withExecutionContext } from '@agent/core/authority';
import {
  approvalEventLogicalPath,
  approvalRequestLogicalPath,
  listApprovalRequests,
  loadApprovalRequest,
} from '@agent/core/governance/approval-store';
import { revokeApprovalAsLocalOwner } from '@agent/core/governance/approval-revocation';
import { cliAgentSessionEnv } from '@agent/core/governance/cli-operator-principal';
import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import type { ServiceRecording } from '@agent/core/service/service-recording';
import { decideApprovalFromCli } from './lib/approval-cli-decision.js';
import { withTtyAnswer } from './lib/tty-io.test-support.js';
import {
  assertServiceRecordingReviewApproval,
  consumeServiceRecordingReviewApproval,
  SERVICE_RECORDING_REVIEW_CHANNEL,
} from '@agent/core/service/service-recording-review-approval';
import { main } from './service_recording.js';

function useSeparationOfDutiesOverlay(file: string): void {
  sod.file = file;
}

function setSeparationOfDuties(enabled: boolean): void {
  const product = JSON.parse(
    String(
      safeReadFile(pathResolver.knowledge('product/governance/approval-policy.json'), {
        encoding: 'utf8',
      })
    )
  );
  safeMkdir(path.dirname(sod.file), { recursive: true });
  safeWriteFile(sod.file, JSON.stringify({ ...product, separation_of_duties: { enabled } }));
  sod.overlayPath = sod.file;
}

function clearSeparationOfDuties(): void {
  sod.overlayPath = null;
  if (sod.file) safeRmSync(sod.file, { force: true });
}

function plainTerminal(): void {
  for (const name of cliAgentSessionEnv()) vi.stubEnv(name, '');
}

const CALLS = JSON.stringify([
  {
    service_id: 'github',
    action: 'create_issue',
    params: { owner: 'famaoai', repo: 'kyberion', title: 'probe' },
    summary: 'Create issue',
  },
]);

describe('service_recording review goes through the approval store', () => {
  const recordingIds: string[] = [];
  const overlayDir = pathResolver.sharedTmp(`service-recording-review-${process.pid}`);

  const recordingPath = (ref: string) => pathResolver.rootResolve(ref);
  const readRecording = (ref: string): ServiceRecording =>
    JSON.parse(String(safeReadFile(recordingPath(ref), { encoding: 'utf8' })));

  async function capture(extra: string[] = []): Promise<{ ref: string; requestId: string }> {
    const recordingId = `svc-review-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    recordingIds.push(recordingId);
    const result = (await main([
      'capture',
      '--target-name',
      'Issue intake',
      '--recording-id',
      recordingId,
      '--calls',
      CALLS,
      ...extra,
    ])) as { value: { recording_ref: string; review_request_id: string } };
    return { ref: result.value.recording_ref, requestId: result.value.review_request_id };
  }

  const stored = (id: string) => loadApprovalRequest(SERVICE_RECORDING_REVIEW_CHANNEL, id)!;

  beforeEach(() => {
    plainTerminal();
    useSeparationOfDutiesOverlay(path.join(overlayDir, `overlay-${Math.random()}.json`));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    clearSeparationOfDuties();
    for (const record of listApprovalRequests({
      storageChannels: [SERVICE_RECORDING_REVIEW_CHANNEL],
    })) {
      if (recordingIds.includes(record.threadTs)) {
        safeRmSync(approvalRequestLogicalPath(SERVICE_RECORDING_REVIEW_CHANNEL, record.id), {
          force: true,
        });
      }
    }
    safeRmSync(approvalEventLogicalPath(SERVICE_RECORDING_REVIEW_CHANNEL), { force: true });
    withExecutionContext('surface_runtime', () => {
      for (const id of recordingIds.splice(0)) {
        safeRmSync(pathResolver.shared(`runtime/recordings/${id}.json`), { force: true });
      }
    });
    safeRmSync(overlayDir, { recursive: true, force: true });
  });

  it('with SoD on, refuses the operator approving a recording they captured', async () => {
    setSeparationOfDuties(true);
    const { ref, requestId } = await capture();
    expect(stored(requestId).requestedBy).toBe('user:owner');

    // Non-interactive: refused before anything is decided.
    await expect(main(['review', '--recording', ref, '--approve'])).rejects.toThrow(
      /this terminal is not interactive/
    );
    // Interactive and past the challenge: the store refuses the self-approval.
    await expect(
      withTtyAnswer(
        (code) => code,
        () =>
          decideApprovalFromCli(stored(requestId), { decision: 'approved', note: 'self review' })
      )
    ).rejects.toThrow(
      /\[POLICY_VIOLATION\] Separation of duties: approval refused because the decider is the same principal/
    );
    expect(stored(requestId).status).toBe('pending');
    expect(readRecording(ref).review?.status).toBe('pending');
  });

  it('with SoD on, --requested-by on capture adds an identity but does not hide the owner', async () => {
    setSeparationOfDuties(true);
    const { requestId } = await capture(['--requested-by', 'agent:x']);
    expect(stored(requestId)).toMatchObject({
      requestedBy: 'agent:x',
      requestedByContext: expect.objectContaining({ actorId: 'user:owner' }),
    });
    await expect(
      withTtyAnswer(
        (code) => code,
        () =>
          decideApprovalFromCli(stored(requestId), { decision: 'approved', note: 'self review' })
      )
    ).rejects.toThrow(/the decider is the same principal/);
  });

  it('with SoD on, a human approves a recording an agent captured; the review points at the approval', async () => {
    setSeparationOfDuties(true);
    vi.stubEnv('CLAUDECODE', '1');
    const { ref, requestId } = await capture();
    expect(stored(requestId).requestedBy).toBe('agent:claude-code');

    plainTerminal();
    // The human answers the TTY challenge (the review command then finds the approval).
    await withTtyAnswer(
      (code) => code,
      () => decideApprovalFromCli(stored(requestId), { decision: 'approved', note: 'review' })
    );
    const result = (await main(['review', '--recording', ref, '--approve'])) as {
      value: { status: string; review_request_id: string };
    };
    expect(result.value).toMatchObject({ status: 'approved', review_request_id: requestId });
    expect(stored(requestId)).toMatchObject({
      status: 'approved',
      decidedBy: 'user:owner',
      decidedVia: 'cli_tty_challenge',
    });
    const review = readRecording(ref).review!;
    expect(review).toMatchObject({
      status: 'approved',
      reviewer: 'user:owner',
      approval_request_id: requestId,
    });
    expect(() => assertServiceRecordingReviewApproval(readRecording(ref), ref)).not.toThrow();
  });

  it('with SoD off, keeps the single-command approve UX and records the decision in the store', async () => {
    const { ref, requestId } = await capture();
    const result = (await main(['review', '--recording', ref, '--approve', '--note', 'ok'])) as {
      value: { status: string };
    };
    expect(result.value.status).toBe('approved');
    expect(stored(requestId)).toMatchObject({ status: 'approved', decidedBy: 'user:owner' });
    const events = String(
      safeReadFile(
        pathResolver.rootResolve(approvalEventLogicalPath(SERVICE_RECORDING_REVIEW_CHANNEL)),
        {
          encoding: 'utf8',
        }
      )
    );
    expect(events).toContain(`"request_id":"${requestId}"`);
    expect(events).toContain('"event":"approved"');
  });

  it('a revoked review approval no longer promotes', async () => {
    vi.stubEnv('CLAUDECODE', '1');
    const { ref, requestId } = await capture();
    plainTerminal();
    await main(['review', '--recording', ref, '--approve']);
    revokeApprovalAsLocalOwner('mission_controller', {
      channel: SERVICE_RECORDING_REVIEW_CHANNEL,
      requestId,
      reason: 'wrong target',
    });
    expect(() => assertServiceRecordingReviewApproval(readRecording(ref), ref)).toThrow(
      /cannot be used because it was revoked by user:owner/
    );
  });

  it('promotion consumes the review approval once; a later revoke reports it consumed', async () => {
    vi.stubEnv('CLAUDECODE', '1');
    const { ref, requestId } = await capture();
    plainTerminal();
    await main(['review', '--recording', ref, '--approve']);
    consumeServiceRecordingReviewApproval(readRecording(ref), 'test-promotion');
    expect(stored(requestId).consumption).toMatchObject({
      consumer: 'service_recording_promotion',
    });
    expect(() => consumeServiceRecordingReviewApproval(readRecording(ref), 'again')).toThrow(
      /already used/
    );
    expect(() =>
      revokeApprovalAsLocalOwner('mission_controller', {
        channel: SERVICE_RECORDING_REVIEW_CHANNEL,
        requestId,
      })
    ).toThrow(/already consumed by service_recording_promotion/);
  });

  it('a review written outside the store promotes only while SoD is off', async () => {
    const { ref } = await capture();
    const legacy: ServiceRecording = {
      ...readRecording(ref),
      review: { status: 'approved', reviewer: 'human:operator', decisions: [] },
    };
    expect(() => assertServiceRecordingReviewApproval(legacy, ref)).not.toThrow();
    setSeparationOfDuties(true);
    expect(() => assertServiceRecordingReviewApproval(legacy, ref)).toThrow(
      /review of .* was not recorded in the approval store.*service_recording request-review.*different member deciding on an authenticated surface \(Chronos or presence-studio\)/
    );
  });
});
