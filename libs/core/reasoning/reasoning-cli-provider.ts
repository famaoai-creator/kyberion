/** DH-04: governed provider module for CLI/ACP reasoning runtimes. */

// Registers the builtin bundle factories into the `cli-provider-bundle`
// named seam as an import side effect, so `buildCliProviderBundle` resolves
// every governed CLI/ACP mode.
import '../provider/bundles/index.js';

export {
  buildCliProviderBundle,
  listCliProviderBundleModes,
  registerCliProviderBundle,
} from '../provider/cli-provider-bundle.js';
export type {
  CliProviderBuildOptions,
  CliProviderBundleFactory,
} from '../provider/cli-provider-bundle.js';
