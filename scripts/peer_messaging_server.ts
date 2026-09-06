import { createStandardYargs } from '@agent/core/cli-utils';
import { logger } from '@agent/core/core';
import { assertProtocolServiceRegistered } from '@agent/core/protocol-service-registry';
import { createPeerMessagingServer } from '@agent/core/peer-messaging';
import { recordProtocolServiceLifecycle } from '@agent/core/protocol-service-lifecycle';
import type { PeerMessageEnvelope } from '@agent/core/peer-messaging';
import { getRegisteredEnvText } from '@agent/core/foundation';
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
    'peer_messaging_server',
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
      description: 'Tenant scope for this peer listener',
    })
    .option('echo', {
      type: 'boolean',
      default: true,
      description: 'Return a small echo payload for inbound requests',
    })
    .parseSync();

  const peerId = String(argv['peer-id']);
  const sharedSecret = String(argv['shared-secret'] || '');
  const tenantId = String(argv['tenant-id'] || '').trim();
  if (!sharedSecret) {
    throw new Error(
      'Missing peer shared secret. Set KYBERION_PEER_SHARED_SECRET or pass --shared-secret.'
    );
  }
  if (!tenantId) throw new Error('Missing tenant id. Set KYBERION_TENANT_ID or pass --tenant-id.');
  if (options.dryRun === true || options.check === true) {
    return {
      dry_run: true,
      operation: 'peer-messaging-server.listen',
      peer_id: peerId,
      tenant_id: tenantId,
      host: String(argv.host),
      port: Number(argv.port),
    };
  }

  const server = createPeerMessagingServer({
    peerId,
    tenantId,
    sharedSecret,
    responder: async ({ envelope }: { envelope: PeerMessageEnvelope }) => {
      if (!argv.echo) {
        return { received: true, peer_id: peerId };
      }
      return {
        received: true,
        peer_id: peerId,
        message_id: envelope.message_id,
        conversation_id: envelope.conversation_id,
        subject: envelope.subject,
        type: envelope.type,
        payload: envelope.payload,
      };
    },
  });

  await server.listen(Number(argv.port), String(argv.host));
  let lifecycleStarted = false;
  try {
    recordProtocolServiceLifecycle({
      serviceId: 'peer-messaging',
      action: 'start',
      status: 'started',
      scope: { scope_kind: 'tenant', tier: 'confidential', tenant_slug: tenantId },
      principal: { kind: 'service', id: peerId },
      requestedBy: peerId,
      metadata: { host: String(argv.host), port: Number(argv.port) },
    });
    lifecycleStarted = true;
    logger.success(
      `[peer-messaging-server] peer ${peerId} listening on http://${String(argv.host)}:${Number(argv.port)}`
    );
  } catch (error) {
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

  const shutdown = async () => {
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

export const runPeerMessagingServer = defineScript({
  name: 'peer:messaging-server',
  run: async ({ argv, dryRun, check, print }) => {
    const result = await main(argv, { dryRun, check });
    if (result) print(result);
    return result;
  },
});

if (
  isDirectScript(import.meta.url, 'peer_messaging_server.ts') ||
  isDirectScript(import.meta.url, 'peer_messaging_server.js')
)
  void runPeerMessagingServer();
