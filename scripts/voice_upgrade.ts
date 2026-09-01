#!/usr/bin/env node
/**
 * Voice Tier Upgrade (Phase A-5.8)
 *
 * Switches the active voice tier between:
 *   - tier 0  (default): browser Web Speech API + OS native TTS, no external deps.
 *   - tier 1  (cloud):   Anthropic Voice or OpenAI Realtime, requires API key.
 *   - tier 2  (local):   Whisper + Style-Bert-VITS2, requires Python + GPU.
 *
 * Usage:
 *   pnpm voice:upgrade cloud     # → tier 1
 *   pnpm voice:upgrade local     # → tier 2
 *   pnpm voice:upgrade --tier 0  # explicit downgrade
 *
 * What it does (this is currently a *configurator*, not a runtime switch):
 *   1. Validates prerequisites for the target tier (API key, Python, etc).
 *   2. Writes the chosen tier to `voice_tier` in the user's
 *      customer/{slug}/voice/profile.json (or knowledge/personal/voice/profile.json).
 *   3. Prints the next-step commands needed to actually run that tier.
 *
 * The runtime selection (which TTS engine to actually call) is not yet wired
 * end-to-end — that lands when the presence-studio voice-hello route ships.
 */

import * as path from 'node:path';
import * as customerResolver from '@agent/core/customer-resolver';
import { classifyError, formatClassification } from '@agent/core/error-classifier';
import { getRegisteredEnv } from '@agent/core/env-validator';
import { pathResolver } from '@agent/core/path-resolver';
import { probeNativeTts } from '@agent/core/native-tts';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeWriteFile,
} from '@agent/core/secure-io';
import { readJson } from '@agent/core/foundation';
import {
  defineScript,
  isDirectScript,
  ScriptExitError,
  stripSharedScriptFlags,
} from './lib/harness.js';

type Tier = 0 | 1 | 2;

interface UpgradeReport {
  requested_tier: Tier;
  applied: boolean;
  dry_run: boolean;
  prerequisites_ok: boolean;
  prerequisites: { name: string; ok: boolean; detail?: string }[];
  next_steps: string[];
  config_path: string;
}

function formatUsage(): string {
  return [
    'Usage: voice_upgrade <cloud|local> | --tier {0|1|2}',
    '',
    'Examples:',
    '  pnpm voice:upgrade cloud',
    '  pnpm voice:upgrade local',
    '  pnpm voice:upgrade --tier 0',
    '  pnpm voice:upgrade -- --dry-run cloud',
  ].join('\n');
}

export function parseVoiceUpgradeArgs(args: readonly string[]): { tier?: Tier; help: boolean } {
  let tier: Tier | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--tier') {
      const value = args[index + 1];
      if (!value || value.startsWith('-')) throw new Error('--tier requires 0, 1, or 2');
      index += 1;
      const parsed = Number(value);
      if (parsed !== 0 && parsed !== 1 && parsed !== 2)
        throw new Error(`--tier must be 0, 1, or 2 (got ${value})`);
      if (tier !== undefined) throw new Error('voice upgrade target was specified more than once');
      tier = parsed as Tier;
      continue;
    }
    if (arg === 'cloud' || arg === 'local') {
      if (tier !== undefined) throw new Error('voice upgrade target was specified more than once');
      tier = arg === 'cloud' ? 1 : 2;
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`unknown option '${arg}'`);
    throw new Error(`unknown voice upgrade target '${arg}'`);
  }
  if (tier !== undefined) return { tier, help: false };
  // Keep direct callers using the old environment bridge compatible while the
  // package aliases converge on the explicit subcommand above.
  const legacyAlias = getRegisteredEnv<string>('KYBERION_VOICE_UPGRADE_ALIAS');
  if (legacyAlias === 'cloud') return { tier: 1, help: false };
  if (legacyAlias === 'local') return { tier: 2, help: false };
  throw new Error(`Missing voice upgrade target.\n${formatUsage()}`);
}

async function checkTier0(): Promise<{ name: string; ok: boolean; detail?: string }[]> {
  const native = await probeNativeTts();
  return [
    {
      name: 'OS native TTS',
      ok: native.available,
      detail: native.available ? `${native.command} on ${native.platform}` : native.reason,
    },
    {
      name: 'presence-studio',
      ok: safeExistsSync(
        path.join(pathResolver.rootDir(), 'presence', 'displays', 'presence-studio')
      ),
      detail: 'Browser surface for Web Speech API input',
    },
  ];
}

function checkTier1(): { name: string; ok: boolean; detail?: string }[] {
  const checks: { name: string; ok: boolean; detail?: string }[] = [];
  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
  const hasOpenAI = !!process.env.OPENAI_API_KEY;
  checks.push({
    name: 'ANTHROPIC_API_KEY',
    ok: hasAnthropic,
    detail: hasAnthropic ? 'set' : 'unset (optional if OpenAI is configured)',
  });
  checks.push({
    name: 'OPENAI_API_KEY',
    ok: hasOpenAI,
    detail: hasOpenAI ? 'set' : 'unset (optional if Anthropic is configured)',
  });
  checks.push({
    name: 'At least one cloud voice provider',
    ok: hasAnthropic || hasOpenAI,
    detail: 'Need ANTHROPIC_API_KEY or OPENAI_API_KEY',
  });
  return checks;
}

function checkTier2(): { name: string; ok: boolean; detail?: string }[] {
  const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
  function whichOk(cmd: string): boolean {
    const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], {
      stdio: 'ignore',
    });
    return r.status === 0;
  }
  return [
    { name: 'python3', ok: whichOk('python3'), detail: 'Required for Style-Bert-VITS2 + Whisper' },
    { name: 'ffmpeg', ok: whichOk('ffmpeg'), detail: 'Required for audio I/O' },
    {
      name: 'Style-Bert-VITS2 server',
      ok: false,
      detail:
        'Manual setup required — see docs/developer/VOICE_FIRST_WIN.md (Tier 1 → Tier 2 section)',
    },
  ];
}

function profilePath(): string {
  // Prefer customer overlay when active, else fall back to personal.
  const customerOverlay = customerResolver.customerRoot('voice/profile.json');
  if (customerOverlay) return customerOverlay;
  return pathResolver.knowledge('personal/voice/profile.json');
}

export function resolveVoiceProfileResourcePath(filePath: string): string {
  return assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
}

function writeTier(tier: Tier): string {
  const out = resolveVoiceProfileResourcePath(profilePath());
  const dir = path.dirname(out);
  if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
  let existing: Record<string, unknown> = {};
  if (safeExistsSync(out)) {
    if (!safeLstat(out).isFile()) throw new Error(`voice profile is not a regular file: ${out}`);
    try {
      existing = readJson<Record<string, unknown>>(out);
    } catch {
      existing = {};
    }
  }
  const updated = {
    ...existing,
    voice_tier: tier,
    updated_at: new Date().toISOString(),
    notes:
      tier === 0
        ? 'Tier 0: browser Web Speech API + OS native TTS. Default, no external deps.'
        : tier === 1
          ? 'Tier 1: cloud voice (Anthropic / OpenAI). Requires API key.'
          : 'Tier 2: local Whisper + Style-Bert-VITS2. Requires Python + GPU.',
  };
  safeWriteFile(resolveVoiceProfileResourcePath(out), JSON.stringify(updated, null, 2) + '\n', {
    encoding: 'utf8',
  });
  return out;
}

function nextStepsForTier(tier: Tier, prereqsOk: boolean, dryRun: boolean): string[] {
  if (dryRun) {
    return [
      prereqsOk
        ? `Dry-run: tier ${tier} would be configured; the profile was not written.`
        : 'Dry-run: prerequisites are incomplete; the profile was not written.',
    ];
  }
  if (!prereqsOk) {
    return [
      'Resolve the prerequisites above before running voice. Re-run this command after resolving.',
    ];
  }
  switch (tier) {
    case 0:
      return [
        'Tier 0 is ready. Run `pnpm chronos:dev` and open the presence surface to see the voice-hello demo.',
      ];
    case 1:
      return [
        'Cloud voice is now configured.',
        'Anthropic Voice path: ensure `ANTHROPIC_API_KEY` is in your shell or OS keychain.',
        'OpenAI Realtime path: ensure `OPENAI_API_KEY` is set.',
        'Run `pnpm chronos:dev` and try the presence voice surface.',
      ];
    case 2:
      return [
        'Tier 2 (local) is configured.',
        'Run `pnpm kyberion voice setup --apply` to install governed mlx-audio / mlx-whisper runtimes.',
        'Follow docs/developer/VOICE_FIRST_WIN.md for the Tier 1 → Tier 2 path, then start the Style-Bert-VITS2 local server.',
        'Run `pnpm chronos:dev` and verify presence surface routes through local voice.',
      ];
  }
}

export async function main(
  args: string[],
  shared: { dryRun?: boolean; check?: boolean } = {}
): Promise<UpgradeReport | string> {
  let parsed: { tier?: Tier; help: boolean };
  try {
    parsed = parseVoiceUpgradeArgs(stripSharedScriptFlags(args));
  } catch (err: any) {
    throw new ScriptExitError(2, formatClassification(classifyError(err)));
  }
  if (parsed.help) return formatUsage();
  const tier = parsed.tier!;
  const dryRun = shared.dryRun === true || shared.check === true;

  let prereqs: { name: string; ok: boolean; detail?: string }[];
  if (tier === 0) prereqs = await checkTier0();
  else if (tier === 1) prereqs = checkTier1();
  else prereqs = checkTier2();

  // For tier 1, "ok" means at least one provider is set.
  const required =
    tier === 1
      ? prereqs.find((p) => p.name === 'At least one cloud voice provider')!.ok
      : prereqs.every((p) => p.ok || p.name === 'Style-Bert-VITS2 server'); // tier-2 server is informational
  const configPath = resolveVoiceProfileResourcePath(profilePath());
  const report: UpgradeReport = {
    requested_tier: tier,
    applied: required && !dryRun,
    dry_run: dryRun,
    prerequisites_ok: required,
    prerequisites: prereqs,
    next_steps: nextStepsForTier(tier, required, dryRun),
    config_path: configPath,
  };
  if (required && !dryRun) writeTier(tier);
  return report;
}

export const runVoiceUpgrade = defineScript({
  name: 'voice:upgrade',
  run: async ({ argv, dryRun, check, print }) => {
    const result = await main(argv, { dryRun, check });
    print(result);
    if (typeof result !== 'string' && !result.prerequisites_ok && !result.dry_run) {
      throw new ScriptExitError(1, '', true);
    }
    return result;
  },
});

if (
  isDirectScript(import.meta.url, 'voice_upgrade.ts') ||
  isDirectScript(import.meta.url, 'voice_upgrade.js')
)
  void runVoiceUpgrade();
