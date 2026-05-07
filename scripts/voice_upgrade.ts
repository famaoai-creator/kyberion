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
 *   pnpm voice:upgrade-cloud     # → tier 1
 *   pnpm voice:upgrade-local     # → tier 2
 *   pnpm voice:upgrade --tier 0  # explicit downgrade
 *
 * What it does (this is currently a *configurator*, not a runtime switch):
 *   1. Validates prerequisites for the target tier (API key, Python, etc).
 *   2. Writes the chosen tier to KYBERION_VOICE_TIER in the user's
 *      customer/{slug}/voice/profile.json (or knowledge/personal/voice/profile.json).
 *   3. Prints the next-step commands needed to actually run that tier.
 *
 * The runtime selection (which TTS engine to actually call) is not yet wired
 * end-to-end — that lands when the presence-studio voice-hello route ships.
 */

import * as path from 'node:path';
import {
  pathResolver,
  customerResolver,
  probeNativeTts,
  classifyError,
  formatClassification,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeWriteFile,
} from '@agent/core';

type Tier = 0 | 1 | 2;

interface UpgradeReport {
  requested_tier: Tier;
  applied: boolean;
  prerequisites: { name: string; ok: boolean; detail?: string }[];
  next_steps: string[];
  config_path: string;
}

function parseArgs(): Tier {
  const args = process.argv.slice(2);
  const tierIdx = args.indexOf('--tier');
  if (tierIdx >= 0 && args[tierIdx + 1]) {
    const t = parseInt(args[tierIdx + 1], 10);
    if (t === 0 || t === 1 || t === 2) return t;
    throw new Error(`--tier must be 0, 1, or 2 (got ${args[tierIdx + 1]})`);
  }
  // Inferred from script alias (set by package.json scripts).
  if (process.env.KYBERION_VOICE_UPGRADE_ALIAS === 'cloud') return 1;
  if (process.env.KYBERION_VOICE_UPGRADE_ALIAS === 'local') return 2;
  throw new Error('Usage: voice_upgrade --tier {0|1|2}');
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
      ok: safeExistsSync(path.join(pathResolver.rootDir(), 'presence', 'displays', 'presence-studio')),
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
    const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' });
    return r.status === 0;
  }
  return [
    { name: 'python3', ok: whichOk('python3'), detail: 'Required for Style-Bert-VITS2 + Whisper' },
    { name: 'ffmpeg', ok: whichOk('ffmpeg'), detail: 'Required for audio I/O' },
    {
      name: 'Style-Bert-VITS2 server',
      ok: false,
      detail: 'Manual setup required — see docs/developer/VOICE_FIRST_WIN.md (TODO: tier-2 install guide)',
    },
  ];
}

function profilePath(): string {
  // Prefer customer overlay when active, else fall back to personal.
  const customerOverlay = customerResolver.customerRoot('voice/profile.json');
  if (customerOverlay) return customerOverlay;
  return pathResolver.knowledge('personal/voice/profile.json');
}

function writeTier(tier: Tier): string {
  const out = profilePath();
  const dir = path.dirname(out);
  if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
  let existing: Record<string, unknown> = {};
  if (safeExistsSync(out)) {
    try {
      existing = JSON.parse(safeReadFile(out, { encoding: 'utf8' }) as string);
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
  safeWriteFile(out, JSON.stringify(updated, null, 2) + '\n', { encoding: 'utf8' });
  return out;
}

function nextStepsForTier(tier: Tier, prereqsOk: boolean): string[] {
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
        'Pull the Style-Bert-VITS2 model + start its local server (see docs/developer/VOICE_FIRST_WIN.md, tier-2 install guide TBD).',
        'Pull the Whisper model (`pip install openai-whisper`).',
        'Run `pnpm chronos:dev` and verify presence surface routes through local voice.',
      ];
  }
}

async function main(): Promise<void> {
  let tier: Tier;
  try {
    tier = parseArgs();
  } catch (err: any) {
    console.error(formatClassification(classifyError(err)));
    process.exit(2);
  }

  console.log(`🎙️  Voice tier upgrade → tier ${tier}`);
  let prereqs: { name: string; ok: boolean; detail?: string }[];
  if (tier === 0) prereqs = await checkTier0();
  else if (tier === 1) prereqs = checkTier1();
  else prereqs = checkTier2();

  console.log('\nPrerequisites:');
  for (const p of prereqs) {
    const icon = p.ok ? '✅' : '❌';
    console.log(`  ${icon}  ${p.name}${p.detail ? ` — ${p.detail}` : ''}`);
  }

  // For tier 1, "ok" means at least one provider is set.
  const required = tier === 1
    ? prereqs.find(p => p.name === 'At least one cloud voice provider')!.ok
    : prereqs.every(p => p.ok || p.name === 'Style-Bert-VITS2 server'); // tier-2 server is informational
  const configPath = writeTier(tier);
  const report: UpgradeReport = {
    requested_tier: tier,
    applied: required,
    prerequisites: prereqs,
    next_steps: nextStepsForTier(tier, required),
    config_path: configPath,
  };

  console.log('\nNext steps:');
  for (const s of report.next_steps) console.log(`  • ${s}`);
  console.log(`\n📝 Profile written: ${path.relative(pathResolver.rootDir(), configPath)}`);

  if (!required) {
    console.error(`\n⚠️  Tier ${tier} prerequisites not fully satisfied. Profile written but tier is not active until prerequisites are resolved.`);
    process.exit(1);
  }
  console.log(`\n✅ Voice tier ${tier} configured.`);
}

main().catch(err => {
  console.error('Fatal:', formatClassification(classifyError(err)));
  process.exit(1);
});
