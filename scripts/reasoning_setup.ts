import { loadEnvironmentManifest, logger, probeManifest } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { formatDoctorSummary, summarizeManifestDoctor } from './environment-doctor.js';
import { formatSetupSummaryLine } from './setup-report.js';

import '@agent/core/environment-capability-probes';

const REASONING_SETUP_GUIDANCE = [
  'Reasoning backend is required for real work. Configure one of:',
  '  - Codex CLI: authenticate `codex`, then set `KYBERION_REASONING_BACKEND=codex-cli`',
  '  - Gemini CLI: authenticate `gemini`, then set `KYBERION_REASONING_BACKEND=gemini-cli`',
  '  - AGY CLI: authenticate `agy`, then set `KYBERION_REASONING_BACKEND=agy-cli`',
  '  - GitHub Copilot CLI: authenticate Copilot CLI, then set `KYBERION_REASONING_BACKEND=copilot`',
  '  - Anthropic API: set `ANTHROPIC_API_KEY`, then set `KYBERION_REASONING_BACKEND=anthropic`',
  '  - OpenAI-compatible local/Nemotron: set `KYBERION_LOCAL_LLM_URL` or `KYBERION_NEMOTRON_URL`',
  'Use `KYBERION_REASONING_BACKEND=stub` only when you intentionally want offline deterministic placeholders.',
];

export async function runReasoningSetup(): Promise<{ must: number; should: number; nice: number }> {
  const manifest = loadEnvironmentManifest('reasoning-backend');
  const probeStatuses = await probeManifest(manifest);
  const summary = summarizeManifestDoctor(manifest, probeStatuses);

  logger.info('');
  logger.info(
    formatSetupSummaryLine([
      ['must', summary.counts.must],
      ['should', summary.counts.should],
      ['nice', summary.counts.nice],
    ])
  );
  for (const line of formatDoctorSummary(summary)) {
    logger.info(line);
  }
  if (summary.counts.must > 0) {
    logger.info('');
    for (const line of REASONING_SETUP_GUIDANCE) {
      logger.info(line);
    }
  }
  logger.info('');

  return summary.counts;
}

async function main(): Promise<void> {
  const argv = await createStandardYargs()
    .option('json', { type: 'boolean', default: false })
    .parseSync();

  const counts = await runReasoningSetup();
  if (argv.json) {
    logger.info(JSON.stringify({ status: 'ok', counts }, null, 2));
    process.exit(counts.must === 0 && counts.should === 0 ? 0 : 1);
  }

  // Interactive backend selection needs a real terminal on both ends —
  // in unattended runs (CI, cron) readline would block forever on stdin.
  const interactiveCapable = process.stdin.isTTY && process.stdout.isTTY;
  if (interactiveCapable && (counts.must > 0 || process.argv.includes('--interactive'))) {
    const rl = (await import('node:readline')).createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    logger.info('');
    logger.info('Interactive Setup:');
    logger.info('1. claude-cli (Recommended)');
    logger.info('2. anthropic');
    logger.info('3. gemini-cli');
    logger.info('4. agy-cli');
    logger.info('5. stub (Offline mock)');

    const answer = await new Promise<string>((resolve) => {
      rl.question('Select reasoning backend [1-5, or enter to skip]: ', resolve);
    });

    rl.close();

    const choices: Record<string, string> = {
      '1': 'claude-cli',
      '2': 'anthropic',
      '3': 'gemini-cli',
      '4': 'agy-cli',
      '5': 'stub',
    };

    if (answer && choices[answer]) {
      const backend = choices[answer];
      logger.info(`Selected: ${backend}`);

      const { safeExistsSync, safeReadFile, safeWriteFile } = await import('@agent/core');
      const path = await import('node:path');
      const envLocal = path.join(process.cwd(), '.env.local');

      let content = '';
      if (safeExistsSync(envLocal)) {
        content = safeReadFile(envLocal, { encoding: 'utf8' }) as string;
      }

      if (content.includes('KYBERION_REASONING_BACKEND=')) {
        content = content.replace(
          /KYBERION_REASONING_BACKEND=.*/g,
          `KYBERION_REASONING_BACKEND=${backend}`
        );
      } else {
        if (content.length > 0 && !content.endsWith('\n')) content += '\n';
        content += `KYBERION_REASONING_BACKEND=${backend}\n`;
      }

      safeWriteFile(envLocal, content);
      logger.info(`Updated .env.local with KYBERION_REASONING_BACKEND=${backend}`);

      if (backend === 'stub') {
        logger.warn(
          'Warning: You have selected the stub backend. It will return deterministic placeholders.'
        );
      }
    }
  }

  process.exit(counts.must === 0 && counts.should === 0 ? 0 : 1);
}

const isDirect = process.argv[1] && /reasoning_setup\.(ts|js)$/.test(process.argv[1]);
if (isDirect) {
  main().catch((err) => {
    logger.error(err?.message ?? String(err));
    process.exit(1);
  });
}
