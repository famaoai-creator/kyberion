import * as path from 'node:path';
import { createStandardYargs } from '@agent/core/cli-utils';
import {
  assertSafeRepositoryPath,
  safeMkdir,
  safeWriteFile,
  safeExistsSync,
  safeLstat,
} from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import { logger } from '@agent/core/core';
import { safeExec } from '@agent/core/secure-io';
import { nowIso, readTextFile } from '@agent/core/foundation';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

export function readIntentSmokeTextFile(filePath: string): string {
  if (!safeExistsSync(filePath) || !safeLstat(filePath).isFile()) {
    throw new Error(`${filePath} must be a regular file`);
  }
  return readTextFile(filePath);
}

const DEFAULT_INTENTS = [
  'verify-actuator-capability',
  'check-kyberion-baseline',
  'diagnose-kyberion-system',
  'verify-environment-readiness',
  'inspect-runtime-supervisor',
];

interface IntentSmokeRunResult {
  summaryText: string;
  failed: number;
  report: Array<{
    intent: string;
    ok: boolean;
    stdout_path: string;
    stderr_path: string;
    exit_code: number;
  }>;
}

export function resolveIntentSmokeOutputDir(outputDir: string): string {
  return assertSafeRepositoryPath(pathResolver.resolve(outputDir), { allowMissingLeaf: true });
}

export async function main(args: string[] = []): Promise<IntentSmokeRunResult> {
  const argv = await createStandardYargs(['node', 'intent_smoke', ...args])
    .option('output', {
      type: 'string',
      default: pathResolver.shared('tmp/intent-smoke'),
      description: 'Directory where per-intent logs will be written',
    })
    .option('intent', {
      type: 'array',
      string: true,
      description: 'Override the default smoke intent list',
    })
    .parseAsync();

  const outputDir = resolveIntentSmokeOutputDir(String(argv.output));
  safeMkdir(outputDir, { recursive: true });

  const intents =
    Array.isArray(argv.intent) && argv.intent.length > 0
      ? argv.intent.map(String)
      : DEFAULT_INTENTS;

  const report: Array<{
    intent: string;
    ok: boolean;
    stdout_path: string;
    stderr_path: string;
    exit_code: number;
  }> = [];

  let failed = 0;
  for (const intent of intents) {
    const safeIntent = intent.replace(/[^a-zA-Z0-9._-]+/g, '_');
    const stdoutPath = path.join(outputDir, `${safeIntent}.out.log`);
    const stderrPath = path.join(outputDir, `${safeIntent}.err.log`);
    logger.info(`[intent-smoke] ${intent}`);
    try {
      const output = safeExec('node', ['dist/scripts/run_intent.js', intent], {
        cwd: pathResolver.rootDir(),
        timeoutMs: 180_000,
        maxOutputMB: 25,
      });
      safeWriteFile(stdoutPath, output);
      safeWriteFile(stderrPath, '');
      const ok = output.trim().length > 0;
      report.push({
        intent,
        ok,
        stdout_path: stdoutPath,
        stderr_path: stderrPath,
        exit_code: 0,
      });
      if (!ok) {
        failed += 1;
        logger.warn(`[intent-smoke] ${intent} did not report succeeded`);
      }
    } catch (error: any) {
      failed += 1;
      const message = error?.message || String(error);
      safeWriteFile(stdoutPath, '');
      safeWriteFile(stderrPath, message);
      report.push({
        intent,
        ok: false,
        stdout_path: stdoutPath,
        stderr_path: stderrPath,
        exit_code: 1,
      });
      logger.warn(`[intent-smoke] ${intent} failed: ${message}`);
    }
  }

  const summaryPath = path.join(outputDir, 'summary.json');
  safeWriteFile(
    summaryPath,
    JSON.stringify(
      {
        generated_at: nowIso(),
        intents: report,
      },
      null,
      2
    )
  );

  const summaryText = safeExistsSync(summaryPath) ? readIntentSmokeTextFile(summaryPath) : '';
  return { summaryText, failed, report };
}

export const runIntentSmoke = defineScript({
  name: 'intent:smoke',
  flags: [],
  run: async (context) => {
    const result = await main(context.argv);
    context.print(result.summaryText);
    if (result.failed > 0) {
      throw new ScriptExitError(1, `intent smoke failed: ${result.failed} intent(s)`);
    }
    return result;
  },
});

if (
  isDirectScript(import.meta.url, 'intent_smoke.ts') ||
  isDirectScript(import.meta.url, 'intent_smoke.js')
)
  void runIntentSmoke();
