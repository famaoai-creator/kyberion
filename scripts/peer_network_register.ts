import {
  createStandardYargs,
  logger,
  registerPeerNetworkPeer,
  type PeerNetworkExposure,
  withExecutionContext,
} from '@agent/core';

function csv(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((entry) => String(entry).trim()).filter(Boolean);
  if (typeof value !== 'string' || !value.trim()) return [];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function main(): Promise<void> {
  const argv = createStandardYargs()
    .option('tenant-id', {
      type: 'string',
      demandOption: true,
      description: 'Tenant that owns the confidential peer catalog',
    })
    .option('peer-id', {
      type: 'string',
      demandOption: true,
      description: 'Remote Kyberion peer identifier',
    })
    .option('base-url', {
      type: 'string',
      demandOption: true,
      description: 'Remote peer HTTP endpoint',
    })
    .option('shared-secret-env', {
      type: 'string',
      default: 'KYBERION_PEER_SHARED_SECRET',
      description: 'Environment variable containing the remote peer shared secret',
    })
    .option('exposure', {
      type: 'string',
      choices: ['same_host', 'same_lan', 'private_network', 'public_network'],
      default: 'same_host',
      description: 'Network reachability and intended exposure of this connection method',
    })
    .option('capabilities', {
      type: 'string',
      description: 'Comma-separated non-secret capability labels',
    })
    .option('description', { type: 'string' })
    .parseSync();

  const secretEnv = String(argv['shared-secret-env']);
  const sharedSecret = process.env[secretEnv] || '';
  if (!sharedSecret) {
    throw new Error(`Missing shared secret in environment variable ${secretEnv}`);
  }

  const result = withExecutionContext('sovereign_concierge', () =>
    registerPeerNetworkPeer({
      tenantId: String(argv['tenant-id']),
      peerId: String(argv['peer-id']),
      baseUrl: String(argv['base-url']),
      sharedSecret,
      exposure: String(argv.exposure) as PeerNetworkExposure,
      capabilities: csv(argv.capabilities),
      description: argv.description ? String(argv.description) : undefined,
    })
  );

  logger.success(`[peer-register] registered ${result.peer.peer_id} in ${result.catalogPath}`);
  console.log(
    JSON.stringify(
      {
        catalog_path: result.catalogPath,
        tenant_id: result.catalog.tenant_id,
        peer: {
          peer_id: result.peer.peer_id,
          base_url: result.peer.base_url,
          exposure: result.peer.exposure,
          allow_local_network: result.peer.allow_local_network,
          capabilities: result.peer.capabilities || [],
        },
      },
      null,
      2
    )
  );
}

main().catch((error: unknown) => {
  logger.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
