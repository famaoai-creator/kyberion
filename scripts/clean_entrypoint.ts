import { runClean } from './clean.js';
import { withCompilerOutputs } from '../libs/core/build-coordination.js';

// This entrypoint is invoked only by the build bootstrap, before package dist exists.
await withCompilerOutputs(async () => runClean());
