#!/usr/bin/env node
import {
  applyVideoFilter,
  listVideoFilterProviders,
  listVideoFilters,
  resolveVideoFilterProvider,
  validateVideoFilterRequest,
  validateVideoFilterSourceId,
} from '@agent/core/video/video-filter';
import { installBuiltinVideoFilterProviders } from '@agent/core/video/video-filter-bootstrap';
import { readJson } from '@agent/core/foundation/json';
import { parseGuardedCliArgs } from '@agent/core/cli-guard';
import { defineScript, isDirectScript } from './lib/harness.js';

export async function runVideoFilter(
  args: string[],
  options: { dryRun?: boolean; print?: (value: unknown) => void } = {}
): Promise<unknown> {
  const parsed = parseGuardedCliArgs(
    args,
    {
      command: 'pnpm kyberion video filter',
      positional: '<inspect|apply>',
      options: [
        { flag: '--input', value: '<filter.json>' },
        { flag: '--source', value: '<source id>' },
        { flag: '--provider', value: '<provider id>' },
      ],
    },
    options.print ?? (() => undefined)
  );
  const [command] = parsed.positionals;
  if (parsed.positionals.length !== 1 || !['inspect', 'apply'].includes(command ?? '')) {
    throw new Error('Expected inspect or apply');
  }
  const providerId = String(parsed.options['--provider'] ?? 'auto').trim();
  if (!providerId) throw new Error('--provider requires a nonempty provider id');
  if (command === 'apply') {
    const file = String(parsed.options['--input'] ?? '').trim();
    if (!file || parsed.options['--source'] !== undefined) {
      throw new Error('apply requires --input and does not accept --source');
    }
    // Structural validation precedes provider installation. A dry run neither
    // resolves credentials nor probes availability; the report makes that scope explicit.
    const request = validateVideoFilterRequest(readJson(file));
    if (options.dryRun) {
      return {
        dry_run: true,
        validation: 'contract_only',
        requested_provider: providerId,
        request,
      };
    }
    installBuiltinVideoFilterProviders();
    return applyVideoFilter(request, providerId);
  }
  if (parsed.options['--input'] !== undefined) throw new Error('inspect does not accept --input');
  const sourceId =
    parsed.options['--source'] === undefined
      ? undefined
      : validateVideoFilterSourceId(parsed.options['--source']);
  if (sourceId && options.dryRun) {
    return {
      dry_run: true,
      operation: 'inspect',
      requested_provider: providerId,
      source_id: sourceId,
    };
  }
  installBuiltinVideoFilterProviders();
  if (sourceId) {
    const provider = resolveVideoFilterProvider(providerId);
    return {
      provider_id: provider.provider_id,
      source_id: sourceId,
      filters: await listVideoFilters(sourceId, provider.provider_id),
    };
  }
  const providers =
    providerId === 'auto' ? listVideoFilterProviders() : [resolveVideoFilterProvider(providerId)];
  return {
    providers: providers.map((provider) => ({
      provider_id: provider.provider_id,
      capabilities: {
        filter_types: [...provider.capabilities.filter_types],
        local_only: provider.capabilities.local_only,
      },
      availability: 'not_probed',
    })),
  };
}

export const main = defineScript({
  name: 'video-filter',
  async run(context) {
    context.print(
      await runVideoFilter(context.positional, { dryRun: context.dryRun, print: context.print })
    );
  },
});

if (
  isDirectScript(import.meta.url, 'video_filter.ts') ||
  isDirectScript(import.meta.url, 'video_filter.js')
)
  void main();
