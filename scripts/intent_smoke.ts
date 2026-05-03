import * as path from 'node:path';
import { createStandardYargs } from '@agent/core/cli-utils';
import { safeMkdir, safeWriteFile, safeExistsSync } from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import { logger, safeExec } from '@agent/core';
import { readTextFile } from './refactor/cli-input.js';

const DEFAULT_INTENTS = [
  'verify-actuator-capability',
  'check-kyberion-baseline',
  'diagnose-kyberion-system',
  'verify-environment-readiness',
  'inspect-runtime-supervisor',
];

async function main(): Promise<void> {
  const argv = await createStandardYargs()
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

  const outputDir = path.resolve(String(argv.output));
  safeMkdir(outputDir, { recursive: true });

  const intents = (Array.isArray(argv.intent) && argv.intent.length > 0
    ? argv.intent.map(String)
    : DEFAULT_INTENTS);

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
  safeWriteFile(summaryPath, JSON.stringify({
    generated_at: new Date().toISOString(),
    intents: report,
  }, null, 2));

  const summaryText = safeExistsSync(summaryPath)
    ? readTextFile(summaryPath)
    : '';
  console.log(summaryText);

  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error: any) => {
  logger.error(error?.message || String(error));
  process.exit(1);
});
