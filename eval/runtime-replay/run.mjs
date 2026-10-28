/** Existing probe-runner command adapter; no provider calls or second eval engine. */
import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExecResult } from '@agent/core/secure-io';

const relative = path.relative(pathResolver.sharedTmp(), process.cwd());
if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
  throw new Error('Run this regression probe from the governed scratch copy through runProbe.');
}

const result = safeExecResult(
  process.execPath,
  [
    pathResolver.rootResolve('node_modules/vitest/vitest.mjs'),
    'run',
    '--root',
    pathResolver.rootDir(),
    'libs/core/harnessing/runtime-replay-battery.test.ts',
    'libs/core/harnessing/runtime-recovery-replay.test.ts',
    'libs/core/provider/provider-health-registry.test.ts',
    'libs/core/workforce/worker-compaction-recovery.test.ts',
    'libs/core/workforce/worker-compaction-snapshot.test.ts',
    '--reporter=json',
    '--outputFile=' + path.join(process.cwd(), 'runtime-replay.json'),
  ],
  { cwd: pathResolver.rootDir(), timeoutMs: 120_000, maxOutputMB: 4 }
);
if (result.stderr) process.stderr.write(result.stderr);
process.exitCode = result.status ?? 1;
