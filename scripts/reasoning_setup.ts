import { loadEnvironmentManifest, probeManifest } from '@agent/core/environment-capability';
import { logger } from '@agent/core/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { getRegisteredEnvText } from '@agent/core/foundation';
import { formatDoctorSummary, summarizeManifestDoctor } from './environment-doctor.js';
import { formatSetupSummaryLine } from './setup-report-format.js';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

import '@agent/core/environment-capability-probes';
import {
  formatReasoningBackendMenu,
  listReasoningBackendChoices,
  persistReasoningBackend,
  readPersistedReasoningBackend,
  resolveReasoningBackendMenuSelection,
} from './reasoning_backend_selection.js';

// Backend ids below mirror the canonical catalog in
// libs/core/reasoning-backend-policy.ts (allowed_modes) — keep them aligned
// with that policy, docs/INITIALIZATION.md, and AGENTS.md §2 (LC-04c).
const REASONING_SETUP_GUIDANCE = [
  'Reasoning backend is required for real work. Configure one of:',
  '  - Claude CLI: authenticate `claude` (Claude Code), then set `KYBERION_REASONING_BACKEND=claude-cli`',
  '    Pitfall (LC-03): if `claude` prints "claude native binary not installed", the pnpm placeholder shim in node_modules/.bin is shadowing your real CLI.',
  '    Fix: run `pnpm approve-builds` (approve @anthropic-ai/claude-code), or set `KYBERION_CLAUDE_CLI_BIN=$HOME/.local/bin/claude`.',
  '  - Codex CLI: authenticate `codex`, then set `KYBERION_REASONING_BACKEND=codex-cli`',
  '  - Gemini CLI: authenticate `gemini`, then set `KYBERION_REASONING_BACKEND=gemini-cli`',
  '  - AGY CLI: authenticate `agy`, then set `KYBERION_REASONING_BACKEND=agy-cli`',
  '  - Grok Build CLI: authenticate `grok` (`grok login`), then set `KYBERION_REASONING_BACKEND=grok-cli`',
  '  - xAI Grok API: set `XAI_API_KEY` (or `KYBERION_GROK_API_KEY`), then set `KYBERION_REASONING_BACKEND=grok-api`',
  '  - GitHub Copilot CLI: authenticate Copilot CLI, then set `KYBERION_REASONING_BACKEND=copilot`',
  '  - Anthropic API: set `ANTHROPIC_API_KEY`, then set `KYBERION_REASONING_BACKEND=anthropic`',
  '  - OpenRouter API: set `OPENROUTER_API_KEY` (or `KYBERION_OPENROUTER_KEY`), then set `KYBERION_REASONING_BACKEND=openrouter`',
  '  - OpenAI-compatible local runtimes: set `KYBERION_OLLAMA_URL`, `KYBERION_VLLM_URL`, `KYBERION_LMSTUDIO_URL`, `KYBERION_LLAMACPP_URL`, `KYBERION_MLX_URL`, `KYBERION_LOCALAI_URL`, `KYBERION_LOCAL_LLM_URL`, or `KYBERION_NEMOTRON_URL`',
  '  - Role routing: use `pnpm reasoning:config list`, `explain`, `validate`, `doctor`, `bind-role`, and `set-fallback --role`',
  '  - Tool access is deny-by-default for local/OpenAI-compatible runtimes; enable only through an explicit governed profile.',
  'Full catalog: knowledge/product/governance/reasoning-backend-policy.json (allowed_modes).',
  'Use `KYBERION_REASONING_BACKEND=stub` only when you intentionally want offline deterministic placeholders.',
];

export async function runReasoningSetup(options: { quiet?: boolean } = {}): Promise<{
  must: number;
  should: number;
  nice: number;
}> {
  const manifest = loadEnvironmentManifest('reasoning-backend');
  const probeStatuses = await probeManifest(manifest);
  const summary = summarizeManifestDoctor(manifest, probeStatuses);

  if (!options.quiet) {
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
  }

  return summary.counts;
}

async function main(args: string[] = []): Promise<void> {
  const argv = await createStandardYargs(['node', 'reasoning_setup', ...args])
    .option('json', { type: 'boolean', default: false })
    .parseSync();

  const counts = await runReasoningSetup();
  if (argv.json) {
    logger.info(JSON.stringify({ status: 'ok', counts }, null, 2));
    if (counts.must > 0 || counts.should > 0) throw new ScriptExitError(1, '', true);
    return;
  }

  // Interactive backend selection needs a real terminal on both ends —
  // in unattended runs (CI, cron) readline would block forever on stdin.
  // LC-05: it also fires when no backend has been persisted yet, so a host
  // where auto-discovery happens to find a CLI still records an explicit
  // choice instead of re-discovering (possibly differently) on every start.
  const interactiveCapable = process.stdin.isTTY && process.stdout.isTTY;
  const persistedBackend =
    getRegisteredEnvText('KYBERION_REASONING_BACKEND')?.trim() || readPersistedReasoningBackend();
  if (
    interactiveCapable &&
    (counts.must > 0 || args.includes('--interactive') || !persistedBackend)
  ) {
    const rl = (await import('node:readline')).createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    // Menu derives from the canonical catalog (reasoning-backend policy).
    const choices = listReasoningBackendChoices();
    logger.info('');
    logger.info('Interactive Setup:');
    for (const line of formatReasoningBackendMenu(choices)) {
      logger.info(line);
    }
    if (persistedBackend) {
      logger.info(`Currently persisted: KYBERION_REASONING_BACKEND=${persistedBackend}`);
    }

    const answer = await new Promise<string>((resolve) => {
      rl.question(
        `Select reasoning backend [1-${choices.length}, name, or enter to skip]: `,
        resolve
      );
    });

    rl.close();

    const backend = resolveReasoningBackendMenuSelection(answer, choices);
    if (backend) {
      logger.info(`Selected: ${backend}`);
      const envLocal = persistReasoningBackend(backend);
      logger.info(`Updated ${envLocal} with KYBERION_REASONING_BACKEND=${backend}`);

      if (backend === 'stub') {
        logger.warn(
          'Warning: You have selected the stub backend. It will return deterministic placeholders.'
        );
      }
    }
  }

  if (counts.must > 0 || counts.should > 0) throw new ScriptExitError(1, '', true);
}

export const runReasoningSetupCli = defineScript({
  name: 'reasoning:setup',
  flags: [],
  run: ({ argv }) => main(argv),
});

if (
  isDirectScript(import.meta.url, 'reasoning_setup.ts') ||
  isDirectScript(import.meta.url, 'reasoning_setup.js')
)
  void runReasoningSetupCli();
