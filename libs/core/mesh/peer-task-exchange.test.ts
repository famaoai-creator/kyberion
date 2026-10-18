import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearPeerRuntime, createPeerMessagingServer } from './peer-messaging.js';
import {
  clearPeerConversationRuntime,
  createPeerConversationResponder,
  loadPeerConversationSession,
} from './peer-conversation.js';
import {
  decidePeerTask,
  deliverPeerTaskResult,
  getPeerTask,
  handleInboundPeerTaskMessage,
  isPeerTaskMessage,
  listPeerTasks,
  loadPeerTaskCatalog,
  peerTaskExecutorArgv,
  peerTaskResultMessageId,
  proposePeerTask,
  resumePeerTask,
  type PeerTaskArtifactWriter,
  type PeerTaskExecutorRunner,
} from './peer-task-exchange.js';
import {
  clearWorkCoordinationStore,
  getWorkItem,
  setWorkCoordinationNamespace,
} from '../workforce/work-coordination.js';
import { withExecutionContext } from '../authority.js';
import { pathResolver } from '../path-resolver.js';
import {
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
} from '../secure-io.js';
import * as crypto from 'node:crypto';

const TENANT = 'tenant-peer-task';
const PROPOSER = 'peer-task-proposer';
const RECIPIENT = 'peer-task-recipient';
const STRANGER = 'peer-task-stranger';
const SECRET = 'peer-task-secret';
const PEER_CATALOG = pathResolver.sharedTmp('peer-task-network.test.json');
const TASK_CATALOG = pathResolver.sharedTmp('peer-task-catalog.test.json');

function writeCatalogs(): void {
  safeWriteFile(
    PEER_CATALOG,
    JSON.stringify({
      version: '1',
      tenant_id: TENANT,
      peers: [PROPOSER, RECIPIENT, STRANGER].map((peer, index) => ({
        peer_id: peer,
        base_url: `http://127.0.0.1:${4660 + index}`,
        shared_secret: SECRET,
        allow_local_network: true,
      })),
    })
  );
  safeWriteFile(
    TASK_CATALOG,
    JSON.stringify({
      version: 1,
      tasks: [
        {
          task_type: 'baseline.check',
          description: 'Run the baseline health check',
          executor: { kind: 'pipeline', pipeline: 'pipelines/baseline-check.json' },
          allowed_from_peers: [PROPOSER],
          timeout_ms: 60_000,
        },
      ],
    })
  );
}

/** Two in-process peers; fetch is routed to the recipient's server by envelope. */
function wirePeers() {
  const servers = new Map(
    [PROPOSER, RECIPIENT, STRANGER].map((peer) => [
      peer,
      createPeerMessagingServer({
        peerId: peer,
        tenantId: TENANT,
        sharedSecret: SECRET,
        responder: createPeerConversationResponder({
          peerId: peer,
          tenantId: TENANT,
          onMessage: ({ session, message, envelope }) =>
            isPeerTaskMessage(message)
              ? {
                  reply: handleInboundPeerTaskMessage({
                    tenantId: TENANT,
                    localPeerId: peer,
                    sessionId: session.session_id,
                    message,
                    envelope,
                    taskCatalogPath: TASK_CATALOG,
                  }),
                }
              : undefined,
        }),
      }),
    ])
  );
  const sent: Array<{ recipient_peer_id: string; message_id: string }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input: unknown, init?: RequestInit) => {
    const envelope = JSON.parse(String(init?.body || '{}'));
    sent.push(envelope);
    const result = await servers.get(envelope.recipient_peer_id)!.processEnvelope(envelope);
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  });
  return { sent };
}

const okRunner: PeerTaskExecutorRunner = async () => ({
  exit_code: 0,
  stdout: 'status=all_clear\n',
  stderr: '',
  started_at: new Date().toISOString(),
  finished_at: new Date().toISOString(),
});

const ARTIFACT_ROOT = pathResolver.sharedTmp(`peer-task-artifacts-${process.pid}`);
/** Hermetic stand-in for the tenant artifact floor. */
const writeArtifact: PeerTaskArtifactWriter = ({ name, content }) => {
  const target = `${ARTIFACT_ROOT}/${name}`;
  safeMkdir(target.slice(0, target.lastIndexOf('/')), { recursive: true });
  safeWriteFile(target, content);
  return target;
};

beforeEach(() => {
  // Tenant-bound roles follow the process tenant; pin it so an operator's
  // KYBERION_TENANT (or a peer task run of this file) cannot leak in.
  vi.stubEnv('KYBERION_TENANT', TENANT);
  setWorkCoordinationNamespace(`peer-task-test-${process.pid}`);
  writeCatalogs();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const peer of [PROPOSER, RECIPIENT, STRANGER]) {
    clearPeerRuntime(TENANT, peer);
    clearPeerConversationRuntime(TENANT, peer);
  }
  for (const file of [PEER_CATALOG, TASK_CATALOG]) {
    if (safeExistsSync(file)) safeRmSync(file, { force: true });
  }
  clearWorkCoordinationStore();
  setWorkCoordinationNamespace(null);
});

afterAll(() => {
  withExecutionContext('infrastructure_sentinel', () => {
    for (const root of ['runtime', 'observability']) {
      for (const area of ['peer-conversations', 'peer-messaging']) {
        const dir = pathResolver.resolve(`active/shared/${root}/${area}/tenants/${TENANT}`);
        if (safeExistsSync(dir)) safeRmSync(dir, { recursive: true, force: true });
      }
    }
  });
  if (safeExistsSync(ARTIFACT_ROOT)) safeRmSync(ARTIFACT_ROOT, { recursive: true, force: true });
});

async function propose(taskType = 'baseline.check', from = PROPOSER) {
  return proposePeerTask({
    tenantId: TENANT,
    senderPeerId: from,
    recipientPeerId: RECIPIENT,
    taskType,
    summary: 'Is your checkout healthy before I hand off?',
    peerCatalogPath: PEER_CATALOG,
  });
}

describe('peer task exchange', () => {
  it('proposes, waits for local acceptance, runs as a WorkItem and returns artifact references', async () => {
    const { sent } = wirePeers();
    const proposed = await propose();
    expect(proposed.record).toMatchObject({ direction: 'outbound', state: 'pending' });
    expect(proposed.reply_text).toContain('pending local acceptance');

    // Transport receipt is not acceptance: nothing ran on the recipient.
    const pending = getPeerTask(TENANT, RECIPIENT, 'inbound', proposed.request.task_id)!;
    expect(pending).toMatchObject({ state: 'pending', remote_peer_id: PROPOSER });
    expect(pending.work_item_id).toBeUndefined();

    const runner = vi.fn(okRunner);
    const done = await decidePeerTask({
      tenantId: TENANT,
      localPeerId: RECIPIENT,
      taskId: proposed.request.task_id,
      decision: 'accepted',
      actorId: 'operator:test',
      reason: 'routine health check',
      taskCatalogPath: TASK_CATALOG,
      peerCatalogPath: PEER_CATALOG,
      runner,
      writeArtifact,
    });
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner.mock.calls[0][0].executor).toEqual({
      kind: 'pipeline',
      pipeline: 'pipelines/baseline-check.json',
    });
    expect(done).toMatchObject({
      state: 'completed',
      decision: { decision: 'accepted', actor_id: 'operator:test' },
      result_delivery: { status: 'sent' },
      result_message_id: peerTaskResultMessageId(proposed.request.task_id),
    });
    expect(getWorkItem(done.work_item_id!)).toMatchObject({
      status: 'done',
      source: 'peer',
      context: { tenant_slug: TENANT },
    });

    // Artifacts stay on the recipient; the result names them by hash.
    const artifacts = done.result!.artifacts;
    expect(artifacts.map((artifact) => artifact.ref.split('/').pop())).toEqual([
      'report.json',
      'output.log',
    ]);
    for (const artifact of artifacts) {
      const content = String(
        safeReadFile(pathResolver.resolve(artifact.ref), { encoding: 'utf8' })
      );
      expect(crypto.createHash('sha256').update(content).digest('hex')).toBe(artifact.sha256);
      expect(artifact.location).toBe('recipient_local');
    }

    // The proposer recorded the result against its outbound task.
    const outbound = getPeerTask(TENANT, PROPOSER, 'outbound', proposed.request.task_id)!;
    expect(outbound).toMatchObject({ state: 'completed', work_item_id: done.work_item_id });
    expect(outbound.result!.artifacts).toEqual(artifacts);
    expect(outbound.result!.summary).toContain('status=all_clear');

    // Resend is idempotent: same message id, one transcript entry on the proposer.
    await deliverPeerTaskResult({
      tenantId: TENANT,
      localPeerId: RECIPIENT,
      taskId: proposed.request.task_id,
      peerCatalogPath: PEER_CATALOG,
    });
    const resultIds = sent
      .filter((envelope) => envelope.recipient_peer_id === PROPOSER)
      .map((envelope) => envelope.message_id);
    expect(new Set(resultIds)).toEqual(
      new Set([peerTaskResultMessageId(proposed.request.task_id)])
    );
    const session = loadPeerConversationSession(TENANT, PROPOSER, proposed.record.session_id)!;
    expect(
      session.transcript.filter(
        (entry) => entry.message_id === peerTaskResultMessageId(proposed.request.task_id)
      )
    ).toHaveLength(1);
  });

  it('records a failed run as failed and blocks the WorkItem', async () => {
    wirePeers();
    const proposed = await propose();
    const done = await decidePeerTask({
      tenantId: TENANT,
      localPeerId: RECIPIENT,
      taskId: proposed.request.task_id,
      decision: 'accepted',
      actorId: 'operator:test',
      reason: 'check',
      taskCatalogPath: TASK_CATALOG,
      peerCatalogPath: PEER_CATALOG,
      writeArtifact,
      runner: async () => ({
        ...(await okRunner({} as never, { tenantId: TENANT })),
        exit_code: 2,
        stderr: 'boom',
      }),
    });
    expect(done.state).toBe('failed');
    expect(done.result!.summary).toContain('boom');
    expect(getWorkItem(done.work_item_id!)!.status).toBe('blocked');
    expect(getPeerTask(TENANT, PROPOSER, 'outbound', proposed.request.task_id)!.state).toBe(
      'failed'
    );
  });

  it('resumes an accepted task that stopped before its result, on the same WorkItem', async () => {
    wirePeers();
    const proposed = await propose();
    const base = {
      tenantId: TENANT,
      localPeerId: RECIPIENT,
      taskId: proposed.request.task_id,
      taskCatalogPath: TASK_CATALOG,
      peerCatalogPath: PEER_CATALOG,
      writeArtifact,
    };
    await expect(
      decidePeerTask({
        ...base,
        decision: 'accepted',
        actorId: 'operator:test',
        reason: 'check',
        runner: async () => {
          throw new Error('executor crashed');
        },
      })
    ).rejects.toThrow(/executor crashed/);
    const stuck = getPeerTask(TENANT, RECIPIENT, 'inbound', proposed.request.task_id)!;
    expect(stuck).toMatchObject({ state: 'running', decision: { decision: 'accepted' } });

    const done = await resumePeerTask({ ...base, runner: okRunner });
    expect(done).toMatchObject({ state: 'completed', work_item_id: stuck.work_item_id });
    expect(getPeerTask(TENANT, PROPOSER, 'outbound', proposed.request.task_id)!.state).toBe(
      'completed'
    );
    await expect(resumePeerTask({ ...base, runner: okRunner })).rejects.toThrow(
      /peer_task_not_resumable/
    );
  });

  it('rejects task types the recipient does not offer, and peers it does not allow, on receipt', async () => {
    wirePeers();
    const unknown = await propose('shell.anything');
    expect(unknown.record.state).toBe('rejected');
    expect(getPeerTask(TENANT, RECIPIENT, 'inbound', unknown.request.task_id)).toMatchObject({
      state: 'rejected',
      decision: { reason: 'task_type_not_offered' },
    });
    const stranger = await propose('baseline.check', STRANGER);
    expect(getPeerTask(TENANT, RECIPIENT, 'inbound', stranger.request.task_id)).toMatchObject({
      state: 'rejected',
      decision: { reason: 'peer_not_allowed' },
    });
  });

  it('lets the operator reject a pending task and tells the proposer', async () => {
    wirePeers();
    const proposed = await propose();
    const runner = vi.fn(okRunner);
    const rejected = await decidePeerTask({
      tenantId: TENANT,
      localPeerId: RECIPIENT,
      taskId: proposed.request.task_id,
      decision: 'rejected',
      actorId: 'operator:test',
      reason: 'busy',
      taskCatalogPath: TASK_CATALOG,
      peerCatalogPath: PEER_CATALOG,
      runner,
    });
    expect(runner).not.toHaveBeenCalled();
    expect(rejected).toMatchObject({
      state: 'rejected',
      result: { status: 'rejected', artifacts: [] },
    });
    expect(getPeerTask(TENANT, PROPOSER, 'outbound', proposed.request.task_id)!.state).toBe(
      'rejected'
    );
    await expect(
      decidePeerTask({
        tenantId: TENANT,
        localPeerId: RECIPIENT,
        taskId: proposed.request.task_id,
        decision: 'accepted',
        actorId: 'operator:test',
        reason: 'changed my mind',
        taskCatalogPath: TASK_CATALOG,
        runner,
      })
    ).rejects.toThrow(/peer_task_already_decided/);
  });

  it('refuses a result from a peer that was not asked, and a re-delivered request is recorded once', async () => {
    wirePeers();
    const proposed = await propose();
    // Re-delivering the same request keeps one inbound record.
    const session = loadPeerConversationSession(TENANT, RECIPIENT, proposed.record.session_id)!;
    const requestEntry = session.transcript.find((entry) => isPeerTaskMessage(entry))!;
    handleInboundPeerTaskMessage({
      tenantId: TENANT,
      localPeerId: RECIPIENT,
      sessionId: session.session_id,
      message: requestEntry,
      envelope: { tenant_id: TENANT, sender_peer_id: PROPOSER } as never,
      taskCatalogPath: TASK_CATALOG,
    });
    expect(listPeerTasks(TENANT, RECIPIENT, { direction: 'inbound' })).toHaveLength(1);

    const forged = {
      ...requestEntry,
      kind: 'status' as const,
      metadata: {
        peer_task_result: {
          kind: 'peer-task-result',
          version: 1,
          task_id: proposed.request.task_id,
          task_type: 'baseline.check',
          status: 'completed',
          summary: 'forged',
          artifacts: [],
          finished_at: new Date().toISOString(),
        },
      },
    };
    expect(() =>
      handleInboundPeerTaskMessage({
        tenantId: TENANT,
        localPeerId: PROPOSER,
        sessionId: session.session_id,
        message: forged,
        envelope: { tenant_id: TENANT, sender_peer_id: STRANGER } as never,
      })
    ).toThrow(/peer_task_unknown/);
  });

  it('rejects requests whose identity does not match the envelope', () => {
    const request = {
      kind: 'peer-task-request',
      version: 1,
      task_id: 'PTK-TEST-00000001',
      task_type: 'baseline.check',
      summary: 'x',
      tenant_id: TENANT,
      sender_peer_id: PROPOSER,
      recipient_peer_id: RECIPIENT,
      requested_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    };
    const message = {
      message_id: 'M-1',
      kind: 'handoff' as const,
      direction: 'inbound' as const,
      sender_peer_id: STRANGER,
      recipient_peer_id: RECIPIENT,
      text: 'x',
      created_at: new Date().toISOString(),
      metadata: { peer_task_request: request },
    };
    expect(() =>
      handleInboundPeerTaskMessage({
        tenantId: TENANT,
        localPeerId: RECIPIENT,
        sessionId: 'PCS-1',
        message,
        envelope: { tenant_id: TENANT, sender_peer_id: STRANGER } as never,
        taskCatalogPath: TASK_CATALOG,
      })
    ).toThrow(/peer_task_identity_mismatch/);
    // Parameters are not part of the contract: an extra field is refused.
    expect(() =>
      handleInboundPeerTaskMessage({
        tenantId: TENANT,
        localPeerId: RECIPIENT,
        sessionId: 'PCS-1',
        message: {
          ...message,
          metadata: { peer_task_request: { ...request, args: ['--rm'] } },
        },
        envelope: { tenant_id: TENANT, sender_peer_id: PROPOSER } as never,
        taskCatalogPath: TASK_CATALOG,
      })
    ).toThrow(/invalid_peer_task_request/);
  });

  it('validates the recipient catalog and builds a fixed argv', () => {
    expect(loadPeerTaskCatalog(TENANT, { catalogPath: TASK_CATALOG }).tasks).toHaveLength(1);
    expect(
      peerTaskExecutorArgv({ kind: 'pipeline', pipeline: 'pipelines/baseline-check.json' })
    ).toEqual(['-s', 'pipeline', '--input', 'pipelines/baseline-check.json']);
    safeWriteFile(
      TASK_CATALOG,
      JSON.stringify({
        version: 1,
        tasks: [
          {
            task_type: 'escape',
            description: 'x',
            executor: { kind: 'pipeline', pipeline: '../etc/passwd.json' },
            allowed_from_peers: [PROPOSER],
          },
        ],
      })
    );
    expect(() => loadPeerTaskCatalog(TENANT, { catalogPath: TASK_CATALOG })).toThrow(
      /invalid_peer_task_catalog/
    );
  });
});
