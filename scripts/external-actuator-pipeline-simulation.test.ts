import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The OS process launch is simulated; the actual resume validator, journal,
// decision API, admission gate and durable reservation are exercised below.
const { launch } = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock('@agent/core/managed-process', async (original) => ({
  ...(await original<typeof import('@agent/core/managed-process')>()),
  spawnManagedProcess: launch,
}));

import { registerEmailBackend } from '@agent/core/integrations/email-bridge';
import {
  approvalStoreRoots,
  computeApprovalPayloadHash,
  decideApprovalRequest,
  loadApprovalRequest,
} from '@agent/core/governance/approval-store';
import { computeApprovalPresentedDigest } from '@agent/core/governance/approval-presentation';
import {
  createPipelineRunJournal,
  loadPipelineRunJournal,
  openPipelineRunJournal,
  type PipelineRunJournalHandle,
} from '@agent/core/pipeline/pipeline-run-journal';
import { resetPipelineApprovalResumeState } from '@agent/core/pipeline/pipeline-approval-resume';
import {
  registerReasoningBackend,
  resetReasoningBackend,
  stubReasoningBackend,
} from '@agent/core/reasoning/reasoning-backend';
import { resetCurrentScope } from '@agent/core/scope-context';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import { withExecutionContext } from '@agent/core/authority';
import { PipelineSuspendedError } from './pipeline-execution-part-bootstrap.js';
import { runValidatedSteps } from './pipeline-execution-part-results.js';

let tenant: string;
let journal: PipelineRunJournalHandle;
const cleanups: string[] = [];
const reportPath = pathResolver.rootResolve(
  `active/shared/tmp/external-actuator-simulation/${randomUUID()}/pipeline-report.json`
);
const verifiedCases: Array<Record<string, unknown>> = [];

function recordSimulationEvidence(
  caseName: string,
  requestId: string,
  assertions: Record<string, unknown>
): void {
  const state = loadPipelineRunJournal(journal.runId);
  const request = loadApprovalRequest('external-operation', requestId);
  verifiedCases.push({
    case: caseName,
    assertions,
    request: request
      ? {
          id: request.id,
          status: request.status,
          kind: request.kind,
          storage_channel: request.storageChannel,
          correlation_id: request.correlationId,
          effect_binding: request.accountability?.effectBinding,
          payload_hash: request.accountability?.payloadHash,
          requested_by_context: request.requestedByContext,
        }
      : undefined,
    journal_projection: {
      run_id: state.run_id,
      completed_nodes: [...state.completed_nodes.values()].map((node) => ({
        step_id: node.step_id,
        output_hash: node.output_hash,
      })),
      events: state.events.map((event) => ({
        sequence: event.sequence,
        event: event.event,
        step_id: event.payload.step_id,
        approval_request_id: event.payload.approval_request_id,
      })),
    },
    simulated_resume_launches: launch.mock.calls.map(([input]) => ({
      args: input.args,
      metadata: input.metadata,
    })),
  });
  safeWriteFile(
    reportPath,
    JSON.stringify(
      {
        status: verifiedCases.length === 2 ? 'passed' : 'incomplete',
        generated_at: new Date().toISOString(),
        real_components: [
          'pipeline dispatch and control flow',
          'email actuator entry and backend registry',
          'external admission and approval gate',
          'isolated approval store and human decision API',
          'pipeline journal and auto-resume validator',
          'durable external execution reservation',
        ],
        simulated_components: ['final email provider transport', 'resume OS process launch'],
        resume_execution: 'real runner driven in-process after validated simulated process launch',
        cases: verifiedCases,
      },
      null,
      2
    ),
    { mkdir: true }
  );
  process.stdout.write(`SIMULATION_REPORT ${reportPath}\n`);
}

describe('real external actuator pipeline simulation', () => {
  beforeEach(() => {
    vi.stubEnv('KYBERION_ALLOW_TEST_NOTIFICATIONS', '0');
    tenant = `sim-${randomUUID().slice(0, 8)}`;
    vi.stubEnv('KYBERION_PERSONA', 'ecosystem_architect');
    vi.stubEnv('MISSION_ROLE', 'mission_controller');
    vi.stubEnv('KYBERION_TENANT', tenant);
    vi.stubEnv('KYBERION_TIER', 'confidential');
    vi.stubEnv('MISSION_ID', undefined);
    vi.stubEnv('SYSTEM_ROLE', 'operator_surface');
    resetCurrentScope();
    resetPipelineApprovalResumeState();
    launch.mockReset();
    launch.mockReturnValue({ child: new EventEmitter() });
    const runId = `simulation-${randomUUID()}`;
    journal = createPipelineRunJournal(runId, {
      pipeline_id: 'external-email-simulation',
      input_path: 'pipelines/simulation-email.json',
      step_ids: ['before', 'send', 'after'],
    });
    cleanups.push(
      journal.path,
      pathResolver.rootResolve(`active/shared/artifacts/confidential/${tenant}`),
      pathResolver.rootResolve(`customer/${tenant}`)
    );
    for (const root of Object.values(approvalStoreRoots()))
      cleanups.push(pathResolver.rootResolve(path.join(root, 'external-operation')));
  });

  afterEach(async () => {
    // Await scheduled resume bookkeeping before deleting the synthetic store.
    await new Promise<void>((resolve) => setImmediate(resolve));
    withExecutionContext('mission_controller', () => {
      for (const file of cleanups.splice(0))
        if (safeExistsSync(file)) safeRmSync(file, { recursive: true, force: true });
    });
    resetReasoningBackend();
    resetPipelineApprovalResumeState();
    vi.unstubAllEnvs();
    resetCurrentScope();
  });

  it('suspends before transport, approves the exact test request, resumes once and refuses replay', async () => {
    const send = vi.fn(async () => ({
      status: 'succeeded' as const,
      provider: 'simulation-email',
      message: 'simulated transport accepted',
    }));
    const backend = `simulation-${randomUUID()}`;
    registerEmailBackend({ id: backend, isAvailable: () => true, send, createDraft: vi.fn() });
    const steps = [
      { id: 'before', op: 'system:log', params: { message: 'simulation before external send' } },
      {
        id: 'send',
        op: 'email:send',
        params: {
          backend,
          to: 'fixture@example.invalid',
          subject: 'Simulation only',
          body: 'No actual email is sent.',
          export_as: 'send_receipt',
        },
      },
      { id: 'after', op: 'system:log', params: { message: 'simulation after external send' } },
    ];
    const opts = { runId: journal.runId, runJournal: journal, quiet: true, hasHuman: true };
    const pending = await runValidatedSteps(steps, {}, opts).catch((error: unknown) => error);
    expect(pending).toBeInstanceOf(PipelineSuspendedError);
    const suspension = (pending as PipelineSuspendedError).suspension;
    expect(suspension.step_id).toBe('send');
    expect(send).not.toHaveBeenCalled();
    journal.append('run_suspended', { ...suspension });
    const suspendedState = loadPipelineRunJournal(journal.runId);
    expect([...suspendedState.completed_nodes.keys()]).toContain('before');
    expect(suspendedState.completed_nodes.has('send')).toBe(false);
    const request = loadApprovalRequest('external-operation', suspension.approval_request_id)!;
    expect(request.status).toBe('pending');
    expect(request.requestedByContext).toMatchObject({
      pipelineRunId: journal.runId,
      stepId: 'send',
    });
    expect(request.accountability?.effectBinding).toBe('email:send');
    const approved = decideApprovalRequest('mission_controller', {
      channel: 'external-operation',
      requestId: request.id,
      decision: 'approved',
      decidedBy: 'user:simulation-human',
      decidedByType: 'human',
      authenticated: true,
      authMethod: 'surface_session',
      presentedDigest: computeApprovalPresentedDigest(request),
      expectedRecordHash: computeApprovalPayloadHash({ record: request }),
    });
    expect(approved.status).toBe('approved');
    await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(1));
    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({
        args: [
          '--input-type=module',
          '-e',
          expect.stringContaining('withScopeEnvOnly'),
          expect.stringMatching(/^file:.*run_pipeline\.js$/),
          expect.any(String),
          '--resume',
          journal.runId,
        ],
      })
    );
    const resumedJournal = openPipelineRunJournal(loadPipelineRunJournal(journal.runId));
    resumedJournal.append('run_resumed', { resumed_at: new Date().toISOString() });
    const resumed = await runValidatedSteps(
      steps,
      {},
      { ...opts, hasHuman: false, runJournal: resumedJournal, resumeState: suspendedState }
    );
    expect(resumed.status).toBe('succeeded');
    expect(send).toHaveBeenCalledTimes(1);
    // A process restart reading the completed journal skips the effect.
    const completed = loadPipelineRunJournal(journal.runId);
    expect(completed.completed_nodes.has('send')).toBe(true);
    expect(completed.completed_nodes.has('after')).toBe(true);
    expect(
      completed.events.filter(
        (event) => event.event === 'node_completed' && event.payload.step_id === 'before'
      )
    ).toHaveLength(1);
    expect(
      (
        await runValidatedSteps(
          steps,
          {},
          {
            ...opts,
            hasHuman: false,
            resumeState: completed,
            runJournal: openPipelineRunJournal(completed),
          }
        )
      ).status
    ).toBe('succeeded');
    expect(send).toHaveBeenCalledTimes(1);
    // Re-execution without the journal checkpoint is blocked by the real reservation.
    const replay = await runValidatedSteps(
      [steps[1]],
      {},
      {
        ...opts,
        hasHuman: false,
        runJournal: openPipelineRunJournal(loadPipelineRunJournal(journal.runId)),
      }
    );
    expect(replay.status).toBe('failed');
    expect(send).toHaveBeenCalledTimes(1);
    expect(() => loadPipelineRunJournal(journal.runId)).not.toThrow();
    recordSimulationEvidence('approved-send-resume-and-replay', request.id, {
      pending_transport_calls: 0,
      final_transport_calls: send.mock.calls.length,
      before_node_completions: completed.events.filter(
        (event) => event.event === 'node_completed' && event.payload.step_id === 'before'
      ).length,
      send_node_completions: completed.events.filter(
        (event) => event.event === 'node_completed' && event.payload.step_id === 'send'
      ).length,
      after_node_completions: completed.events.filter(
        (event) => event.event === 'node_completed' && event.payload.step_id === 'after'
      ).length,
      resumed_status: resumed.status,
      forced_replay_status: replay.status,
    });
  });

  it('treats an ambiguous attempted send as terminal and never invokes model repair', async () => {
    const send = vi.fn(async () => ({
      status: 'failed' as const,
      provider: 'simulation-email',
      error: 'simulated connection loss after possible send',
    }));
    const backend = `simulation-${randomUUID()}`;
    registerEmailBackend({ id: backend, isAvailable: () => true, send, createDraft: vi.fn() });
    const repair = vi.fn(async () => {
      throw new Error('model repair must not run');
    });
    registerReasoningBackend({
      ...stubReasoningBackend,
      name: 'simulation-no-repair',
      delegateTask: repair,
      prompt: repair,
    });
    const steps = [
      {
        id: 'send',
        op: 'email:send',
        params: {
          backend,
          to: 'fixture@example.invalid',
          subject: 'Simulation only',
          body: 'No actual email is sent.',
        },
      },
    ];
    const opts = { runId: journal.runId, runJournal: journal, quiet: true, hasHuman: true };
    const pending = await runValidatedSteps(steps, {}, opts).catch((error: unknown) => error);
    expect(pending).toBeInstanceOf(PipelineSuspendedError);
    const suspension = (pending as PipelineSuspendedError).suspension;
    journal.append('run_suspended', { ...suspension });
    const request = loadApprovalRequest('external-operation', suspension.approval_request_id)!;
    decideApprovalRequest('mission_controller', {
      channel: 'external-operation',
      requestId: request.id,
      decision: 'approved',
      decidedBy: 'user:simulation-human',
      decidedByType: 'human',
      authenticated: true,
      authMethod: 'surface_session',
      presentedDigest: computeApprovalPresentedDigest(request),
    });
    await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(1));
    const state = loadPipelineRunJournal(journal.runId);
    const resumedJournal = openPipelineRunJournal(state);
    resumedJournal.append('run_resumed', { resumed_at: new Date().toISOString() });
    const result = await runValidatedSteps(
      steps,
      {},
      { ...opts, hasHuman: false, runJournal: resumedJournal, resumeState: state }
    );
    expect(result.status).toBe('failed');
    expect(send).toHaveBeenCalledTimes(1);
    expect(repair).not.toHaveBeenCalled();
    const repeated = await runValidatedSteps(
      steps,
      {},
      { ...opts, hasHuman: false, runJournal: resumedJournal }
    );
    expect(repeated.status).toBe('failed');
    expect(send).toHaveBeenCalledTimes(1);
    expect(repair).not.toHaveBeenCalled();
    recordSimulationEvidence('unknown-outcome-terminal', request.id, {
      final_transport_calls: send.mock.calls.length,
      model_repair_calls: repair.mock.calls.length,
      attempted_status: result.status,
      repeated_status: repeated.status,
    });
  });
});
