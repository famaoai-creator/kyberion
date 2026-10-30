/** Host composition root. Public filtering contracts and the CLI never choose
 * implementations by branching on a requested vendor name. */
import { createObsVideoFilterProvider } from './obs-video-filter-provider.js';
import { listVideoFilterProviders, registerVideoFilterProvider } from './video-filter.js';

const builtins = [{ id: 'obs', create: createObsVideoFilterProvider }] as const;

/** Explicit startup registration only; preserve providers installed by a host
 * or plugin. Availability and requested capabilities are resolved separately. */
export function installBuiltinVideoFilterProviders(): void {
  for (const builtin of builtins) {
    if (listVideoFilterProviders().some((provider) => provider.provider_id === builtin.id))
      continue;
    registerVideoFilterProvider(builtin.create(), {
      provenance: 'builtin',
      source: 'video-filter-bootstrap',
    });
  }
}
