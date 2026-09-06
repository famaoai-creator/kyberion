import * as path from 'node:path';
import {
  runBackendConformance,
  runBackendSandboxConformance,
  type BackendConformanceReport,
} from '@agent/core/backend-conformance';
import { withExecutionContext } from '@agent/core/authority';
import { pathResolver } from '@agent/core/path-resolver';
import { assertSafeRepositoryPath, safeMkdir, safeWriteFile } from '@agent/core/secure-io';
import { defineScript, isDirectScript } from './lib/harness.js';

function arg(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

export const runCheckBackendConformance = defineScript({
  name: 'check:backend-conformance',
  flags: [],
  run(context) {
    const out =
      arg(context.argv, '--out') ||
      pathResolver.rootResolve('active/shared/runtime/backend-conformance.json');
    const sandbox = context.argv.includes('--live-sandbox');
    const report: BackendConformanceReport = sandbox
      ? {
          ...runBackendConformance(),
          probe: 'live-cli-version-help+sandbox',
          sandbox: runBackendSandboxConformance(),
        }
      : runBackendConformance();
    const outputPath = assertSafeRepositoryPath(pathResolver.resolve(out), {
      allowMissingLeaf: true,
    });
    withExecutionContext('ecosystem_architect', () => {
      safeMkdir(path.dirname(outputPath), { recursive: true });
      safeWriteFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    });
    context.print(report);
  },
});

if (
  isDirectScript(import.meta.url, 'check_backend_conformance.ts') ||
  isDirectScript(import.meta.url, 'check_backend_conformance.js')
)
  void runCheckBackendConformance();
