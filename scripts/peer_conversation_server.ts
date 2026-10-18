import { createStandardYargs } from '@agent/core/cli-utils';
import { logger } from '@agent/core/core';
import { createPeerMessagingServer } from '@agent/core/mesh/peer-messaging';
import { createMeshHubPeerMessagingAdapter } from '@agent/core/mesh/mesh-hub-peer-messaging-adapter';
import { createPeerConversationResponder } from '@agent/core/mesh/peer-conversation';
import { createPeerAutoReply } from '@agent/core/mesh/peer-auto-reply';
import {
  advertiseMeshCapabilities,
  recordMeshHeartbeat,
  registerMeshPeer,
} from '@agent/core/mesh/mesh-peer-directory';
import { assertProtocolServiceRegistered } from '@agent/core/protocol-service-registry';
import { recordProtocolServiceLifecycle } from '@agent/core/protocol-service-lifecycle';
import type { MeshRequest } from '@agent/core/mesh/mesh-hub-contract';
import { getRegisteredEnvText, nowIso } from '@agent/core/foundation';
import { defineScript, isDirectScript, stripSharedScriptFlags } from './lib/harness.js';

function normalizePeerServerArguments(args: string[]): string[] {
  return stripSharedScriptFlags(args);
}

async function main(
  args: string[] = [],
  options: { dryRun?: boolean; check?: boolean } = {}
): Promise<unknown> {
  assertProtocolServiceRegistered('peer-messaging');
  const argv = await createStandardYargs([
    'node',
    'peer_conversation_server',
    ...normalizePeerServerArguments(args),
  ])
    .option('peer-id', {
      type: 'string',
      demandOption: true,
      description: 'Logical peer identifier for this Kyberion instance',
    })
    .option('port', {
      type: 'number',
      default: Number(getRegisteredEnvText('KYBERION_PEER_PORT') || 4100),
      description: 'HTTP port to bind',
    })
    .option('host', {
      type: 'string',
      default: getRegisteredEnvText('KYBERION_PEER_HOST') || '127.0.0.1',
      description: 'HTTP bind host (use 0.0.0.0 for LAN reachability)',
    })
    .option('shared-secret', {
      type: 'string',
      default: getRegisteredEnvText('KYBERION_PEER_SHARED_SECRET') || '',
      description: 'HMAC shared secret used to verify inbound messages',
    })
    .option('tenant-id', {
      type: 'string',
      default: getRegisteredEnvText('KYBERION_TENANT_ID') || '',
      description: 'Enable Mesh presence for this same-tenant peer',
    })
    .option('key-ref', {
      type: 'string',
      default: getRegisteredEnvText('KYBERION_PEER_KEY_REF') || 'env:KYBERION_PEER_SHARED_SECRET',
      description: 'Secret reference recorded in Mesh enrollment (never the secret value)',
    })
    .option('mesh-namespace', {
      type: 'string',
      default: getRegisteredEnvText('KYBERION_MESH_NAMESPACE') || '',
      description: 'Optional isolated Mesh Hub namespace',
    })
    .option('heartbeat-ms', {
      type: 'number',
      default: 10_000,
      description: 'Mesh presence heartbeat interval',
    })
    .option('presence-ttl-ms', {
      type: 'number',
      default: 30_000,
      description: 'Mesh presence freshness window',
    })
    .option('max-inflight', {
      type: 'number',
      default: 8,
      description: 'Maximum concurrent inbound peer message handlers',
    })
    .option('max-queued', {
      type: 'number',
      default: 64,
      description: 'Maximum inbound requests waiting for a handler slot before retryable overload',
    })
    .option('auto-reply-peers', {
      type: 'string',
      default: '',
      description: 'Comma-separated peer ids that receive LLM auto replies (empty = disabled)',
    })
    .option('auto-reply-max-turns', {
      type: 'number',
      default: 6,
      description: 'Maximum auto-reply turns per session (inbound auto_turn and replies sent)',
    })
    .option('auto-reply-timeout-ms', {
      type: 'number',
      default: 60_000,
      description: 'Auto-reply generation timeout',
    })
    .option('auto-reply-concurrency', {
      type: 'number',
      default: 1,
      description: 'Maximum concurrent auto-reply jobs',
    })
    .option('auto-reply-max-attempts', {
      type: 'number',
      default: 3,
      description: 'Maximum auto-reply delivery attempts',
    })
    .option('auto-reply-knowledge-limit', {
      type: 'number',
      default: 5,
      description: 'Tenant knowledge excerpts injected into an auto-reply prompt',
    })
    .option('auto-reply-budget-per-hour', {
      type: 'number',
      default: 30,
      description: 'Rolling hourly cap on auto-reply jobs per remote peer',
    })
    .parseSync();

  const peerId = String(argv['peer-id']);
  const sharedSecret = String(argv['shared-secret'] || '');
  if (!sharedSecret) {
    throw new Error(
      'Missing peer shared secret. Set KYBERION_PEER_SHARED_SECRET or pass --shared-secret.'
    );
  }

  const host = String(argv.host);
  const port = Number(argv.port);
  const tenantId = String(argv['tenant-id'] || '').trim();
  if (!tenantId) {
    throw new Error('Missing tenant id. Set KYBERION_TENANT_ID or pass --tenant-id.');
  }
  const maxInflight = Number(argv['max-inflight']);
  const maxQueued = Number(argv['max-queued']);
  if (
    !Number.isInteger(maxInflight) ||
    maxInflight < 1 ||
    !Number.isInteger(maxQueued) ||
    maxQueued < 0
  ) {
    throw new Error('invalid_peer_receive_capacity');
  }
  const autoReplyPeers = String(argv['auto-reply-peers'] || '')
    .split(',')
    .map((peer) => peer.trim())
    .filter(Boolean);
  const autoReplyOptions = {
    max_turns: Number(argv['auto-reply-max-turns']),
    timeout_ms: Number(argv['auto-reply-timeout-ms']),
    concurrency: Number(argv['auto-reply-concurrency']),
    max_attempts: Number(argv['auto-reply-max-attempts']),
    knowledge_limit: Number(argv['auto-reply-knowledge-limit']),
    budget_per_hour: Number(argv['auto-reply-budget-per-hour']),
  };
  if (
    !Number.isInteger(autoReplyOptions.max_turns) ||
    autoReplyOptions.max_turns < 0 ||
    !Number.isInteger(autoReplyOptions.timeout_ms) ||
    autoReplyOptions.timeout_ms < 1 ||
    !Number.isInteger(autoReplyOptions.concurrency) ||
    autoReplyOptions.concurrency < 1 ||
    !Number.isInteger(autoReplyOptions.max_attempts) ||
    autoReplyOptions.max_attempts < 1 ||
    !Number.isInteger(autoReplyOptions.knowledge_limit) ||
    autoReplyOptions.knowledge_limit < 0 ||
    !Number.isInteger(autoReplyOptions.budget_per_hour) ||
    autoReplyOptions.budget_per_hour < 1
  ) {
    throw new Error('invalid_peer_auto_reply_options');
  }
  if (options.dryRun === true || options.check === true) {
    return {
      dry_run: true,
      operation: 'peer-conversation-server.listen',
      peer_id: peerId,
      tenant_id: tenantId,
      host,
      port,
      max_inflight: maxInflight,
      max_queued: maxQueued,
      auto_reply: {
        enabled: autoReplyPeers.length > 0,
        peers: autoReplyPeers,
        ...autoReplyOptions,
      },
    };
  }
  const meshNamespace = String(argv['mesh-namespace'] || '').trim() || undefined;
  const meshAdapter = createMeshHubPeerMessagingAdapter({
    peerId,
    tenantId,
    sharedSecret,
    namespace: meshNamespace,
  });

  const autoReply = createPeerAutoReply({
    tenantId,
    localPeerId: peerId,
    enabledPeers: autoReplyPeers,
    maxTurns: autoReplyOptions.max_turns,
    generationTimeoutMs: autoReplyOptions.timeout_ms,
    concurrency: autoReplyOptions.concurrency,
    maxDeliveryAttempts: autoReplyOptions.max_attempts,
    knowledgeLimit: autoReplyOptions.knowledge_limit,
    budgetPerHour: autoReplyOptions.budget_per_hour,
  });

  const server = createPeerMessagingServer({
    peerId,
    tenantId,
    sharedSecret,
    maxInflight,
    maxQueued,
    responder: createPeerConversationResponder({
      peerId,
      tenantId,
      onMessage: (context) => {
        const { message, envelope } = context;
        const candidate = message.metadata?.collaboration_request as MeshRequest | undefined;
        if (!candidate || message.kind !== 'handoff') return autoReply.handleInbound(context);
        if (!tenantId) throw new Error('mesh_collaboration_requires_tenant_id');
        if (candidate.sender_peer_id !== envelope.sender_peer_id) {
          throw new Error(`mesh_collaboration_sender_mismatch:${candidate.request_id}`);
        }
        if (candidate.tenant_scope?.tenant_id !== tenantId) {
          throw new Error(`mesh_collaboration_tenant_mismatch:${candidate.request_id}`);
        }
        const proposal = meshAdapter.proposeLocalRequest(candidate, envelope.message_id);
        return {
          reply: {
            message_id: `PCR-${proposal.proposal_id}`,
            kind: 'reply',
            direction: 'outbound',
            sender_peer_id: peerId,
            recipient_peer_id: envelope.sender_peer_id,
            text: `Transport accepted; proposal ${proposal.proposal_id} is pending local acceptance.`,
            created_at: nowIso(),
            related_work_item_ids: message.related_work_item_ids,
            payload: {
              proposal_id: proposal.proposal_id,
              proposal_status: 'pending',
              request_id: proposal.request_id,
              mission_controller_mutation: 'deny',
            },
          },
        };
      },
    }),
  });

  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  const heartbeat = (health: 'healthy' | 'maintenance' = 'healthy') => {
    if (!tenantId) return;
    const now = Date.now();
    const capacity = server.getCapacity();
    recordMeshHeartbeat({
      peer_id: peerId,
      tenant_id: tenantId,
      heartbeat_at: new Date(now),
      expires_at: new Date(health === 'maintenance' ? now : now + Number(argv['presence-ttl-ms'])),
      health,
      capacity: {
        ...capacity,
        accepting_new_work: health === 'healthy' && capacity.accepting_new_work,
      },
      receive_modes: ['request', 'capability_query', 'workitem'],
    });
  };

  await server.listen(port, host);
  let lifecycleStarted = false;
  try {
    recordProtocolServiceLifecycle({
      serviceId: 'peer-messaging',
      action: 'start',
      status: 'started',
      scope: { scope_kind: 'tenant', tier: 'confidential', tenant_slug: tenantId },
      principal: { kind: 'service', id: peerId },
      requestedBy: peerId,
      metadata: { host, port, mesh_namespace: meshNamespace || null },
    });
    lifecycleStarted = true;

    if (tenantId) {
      const endpointHost = host === '0.0.0.0' ? '127.0.0.1' : host;
      const allowedRequestKinds = [
        'review.request',
        'workitem.claim',
        'workitem.handoff',
        'workitem.status_update',
        'capability.query',
        'notification.publish',
      ] as const;
      registerMeshPeer({
        peer_id: peerId,
        tenant_id: tenantId,
        endpoint_ref: `http://${endpointHost}:${port}`,
        key_ref: String(argv['key-ref']),
        allowed_request_kinds: [...allowedRequestKinds],
        authority_role: 'infrastructure_sentinel',
      });
      advertiseMeshCapabilities({
        peer_id: peerId,
        tenant_id: tenantId,
        capability_id: 'peer.collaboration',
        version: '1.0.0',
        roles: ['collaboration-peer'],
        request_kinds: [...allowedRequestKinds],
      });
      heartbeat();
      heartbeatTimer = setInterval(() => heartbeat(), Number(argv['heartbeat-ms']));
    }
  } catch (error) {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (lifecycleStarted) {
      try {
        recordProtocolServiceLifecycle({
          serviceId: 'peer-messaging',
          action: 'stop',
          status: 'stopped',
          scope: { scope_kind: 'tenant', tier: 'confidential', tenant_slug: tenantId },
          principal: { kind: 'service', id: peerId },
          requestedBy: peerId,
        });
      } catch {
        // Preserve the startup failure; the server is still closed below.
      }
    }
    await server.close();
    throw error;
  }
  logger.success(`[peer-conversation-server] peer ${peerId} listening on http://${host}:${port}`);
  if (autoReply.enabled) {
    autoReply.start();
    logger.info(
      `[peer-conversation-server] auto reply enabled for peers: ${autoReplyPeers.join(', ')}`
    );
  }

  const shutdown = async () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeat('maintenance');
    await autoReply.stop();
    try {
      recordProtocolServiceLifecycle({
        serviceId: 'peer-messaging',
        action: 'stop',
        status: 'stopped',
        scope: { scope_kind: 'tenant', tier: 'confidential', tenant_slug: tenantId },
        principal: { kind: 'service', id: peerId },
        requestedBy: peerId,
      });
    } finally {
      await server.close();
    }
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

export const runPeerConversationServer = defineScript({
  name: 'peer:conversation-server',
  run: async ({ argv, dryRun, check, print }) => {
    const result = await main(argv, { dryRun, check });
    if (result) print(result);
    return result;
  },
});

if (
  isDirectScript(import.meta.url, 'peer_conversation_server.ts') ||
  isDirectScript(import.meta.url, 'peer_conversation_server.js')
)
  void runPeerConversationServer();
