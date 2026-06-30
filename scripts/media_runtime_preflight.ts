#!/usr/bin/env node
import { createStandardYargs } from '@agent/core/cli-utils';
import { logger, probeServiceRuntime } from '@agent/core';

export type MediaRuntimePreflightReport = {
  serviceId: string;
  available: boolean;
  reason: string;
  probeUrl?: string;
  baseUrl?: string;
  managedServicePath?: string;
};

export async function runMediaRuntimePreflight(options: {
  serviceId?: string;
} = {}): Promise<MediaRuntimePreflightReport> {
  const serviceId = options.serviceId?.trim() || 'comfyui';
  const resolution = await probeServiceRuntime(serviceId, 'trial');

  const report: MediaRuntimePreflightReport = {
    serviceId,
    available: resolution.available,
    reason: resolution.reason,
    probeUrl: resolution.probe_url,
    baseUrl: resolution.base_url,
    managedServicePath: resolution.managed_service_path,
  };

  logger.info('');
  logger.info(`[media-preflight] service=${serviceId}`);
  logger.info(`[media-preflight] available=${resolution.available ? 'yes' : 'no'}`);
  logger.info(`[media-preflight] reason=${resolution.reason}`);
  if (resolution.probe_url) {
    logger.info(`[media-preflight] probe_url=${resolution.probe_url}`);
  }
  if (resolution.base_url) {
    logger.info(`[media-preflight] base_url=${resolution.base_url}`);
  }
  if (resolution.managed_service_path) {
    logger.info(`[media-preflight] managed_service_path=${resolution.managed_service_path}`);
  }
  if (!resolution.available) {
    logger.info('[media-preflight] next step: provision or start the media service runtime, then rerun `pnpm service:preflight -- --service media-generation`.');
  }
  logger.info('');

  return report;
}

async function main(): Promise<void> {
  const argv = await createStandardYargs()
    .option('service', {
      type: 'string',
      default: 'comfyui',
      describe: 'Service runtime to probe before media generation',
    })
    .option('json', { type: 'boolean', default: false })
    .parseSync();

  const report = await runMediaRuntimePreflight({ serviceId: String(argv.service) });
  if (argv.json) {
    logger.info(JSON.stringify({ status: 'ok', report }, null, 2));
  }

  process.exit(report.available ? 0 : 1);
}

const isDirect = process.argv[1] && /media_runtime_preflight\.(ts|js)$/.test(process.argv[1]);
if (isDirect) {
  main().catch((err) => {
    logger.error(err?.message ?? String(err));
    process.exit(1);
  });
}
