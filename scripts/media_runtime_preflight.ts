#!/usr/bin/env node
import { createStandardYargs } from '@agent/core/cli-utils';
import { logger, probeServiceRuntime } from '@agent/core';
import { defineScript, isDirectScript } from './lib/harness.js';

export type MediaRuntimePreflightReport = {
  serviceId: string;
  available: boolean;
  reason: string;
  probeUrl?: string;
  baseUrl?: string;
  managedServicePath?: string;
};

export async function runMediaRuntimePreflight(
  options: {
    serviceId?: string;
  } = {}
): Promise<MediaRuntimePreflightReport> {
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
    logger.info(
      '[media-preflight] next step: provision or start the media service runtime, then rerun `pnpm service:preflight -- --service media-generation`.'
    );
  }
  logger.info('');

  return report;
}

async function main(args: string[] = []): Promise<number> {
  const argv = await createStandardYargs(['node', 'media_runtime_preflight', ...args])
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

  return report.available ? 0 : 1;
}

if (
  isDirectScript(import.meta.url, 'media_runtime_preflight.ts') ||
  isDirectScript(import.meta.url, 'media_runtime_preflight.js')
) {
  void defineScript({
    name: 'media:runtime-preflight',
    flags: [],
    async run(context) {
      const status = await main(context.argv);
      if (status !== 0) throw new Error(`media:runtime-preflight failed with exit code ${status}`);
    },
  })();
}
