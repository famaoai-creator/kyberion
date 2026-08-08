import * as path from 'node:path';
import {
  pathResolver,
  runBackendConformance,
  safeMkdir,
  safeWriteFile,
  withExecutionContext,
} from '@agent/core';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const out =
  arg('--out') || pathResolver.rootResolve('active/shared/runtime/backend-conformance.json');
const report = runBackendConformance();
const outputPath = pathResolver.resolve(out);
withExecutionContext('ecosystem_architect', () => {
  safeMkdir(path.dirname(outputPath), { recursive: true });
  safeWriteFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
});
console.log(JSON.stringify(report, null, 2));
