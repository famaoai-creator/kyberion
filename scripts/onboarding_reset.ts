#!/usr/bin/env node
import * as path from 'node:path';
import * as readline from 'node:readline';
import { resolveActiveProfileRoot } from '@agent/core/profile-root';
import { safeExistsSync, safeRmSync } from '@agent/core/secure-io';
import { defineScript, isDirectScript } from './lib/harness.js';

export interface OnboardingResetOptions {
  force?: boolean;
  dryRun?: boolean;
  profileRoot?: string;
  confirm?: () => Promise<boolean>;
  print?: (value: string) => void;
}

export interface OnboardingResetResult {
  profileRoot: string;
  removed: string[];
  planned?: string[];
  dryRun?: boolean;
}

function onboardingArtifactPaths(profileRoot: string): string[] {
  return [
    path.join(profileRoot, 'onboarding'),
    path.join(profileRoot, 'my-identity.json'),
    path.join(profileRoot, 'my-vision.md'),
    path.join(profileRoot, 'agent-identity.json'),
  ];
}

function formatPathList(root: string, paths: string[]): string {
  return paths.map((value) => `- ${path.relative(root, value) || '.'}`).join('\n');
}

function createPrompt(): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(
      'Reset onboarding artifacts? This will delete onboarding state and generated identity artifacts. (y/N): ',
      (answer) => {
        rl.close();
        resolve(/^(y|yes|true|1)$/i.test(answer.trim()));
      }
    );
  });
}

export async function resetOnboardingArtifacts(
  options: OnboardingResetOptions = {}
): Promise<OnboardingResetResult> {
  const profileRoot = options.profileRoot ?? resolveActiveProfileRoot();
  const targets = onboardingArtifactPaths(profileRoot);
  const existingTargets = targets.filter((target) => safeExistsSync(target));

  if (existingTargets.length === 0) {
    return options.dryRun
      ? { profileRoot, removed: [], planned: [], dryRun: true }
      : { profileRoot, removed: [] };
  }

  if (options.dryRun) {
    return { profileRoot, removed: [], planned: existingTargets, dryRun: true };
  }

  let proceed = options.force ?? false;
  if (!proceed) {
    if (options.confirm) {
      proceed = await options.confirm();
    } else if (process.stdin.isTTY && process.stdout.isTTY) {
      const print = options.print ?? (() => undefined);
      print(
        `About to reset onboarding artifacts under: ${path.relative(process.cwd(), profileRoot)}`
      );
      print(formatPathList(profileRoot, existingTargets));
      proceed = await createPrompt();
    } else {
      throw new Error('onboard reset requires a TTY confirmation or --force');
    }
  }

  if (!proceed) {
    return { profileRoot, removed: [] };
  }

  const removed: string[] = [];
  for (const target of existingTargets) {
    safeRmSync(target, { recursive: true, force: true });
    removed.push(target);
  }

  return { profileRoot, removed };
}

export function formatResetSummary(result: OnboardingResetResult): string {
  if (result.dryRun) {
    if (result.planned?.length === 0) {
      return `No onboarding artifacts found under ${result.profileRoot}.`;
    }
    return [
      'Onboarding reset preview (no files changed).',
      `Profile root: ${result.profileRoot}`,
      'Would remove:',
      formatPathList(result.profileRoot, result.planned || []),
      '',
      'Next step: rerun without `--dry-run` or `--check` to request confirmation.',
    ].join('\n');
  }
  if (result.removed.length === 0) {
    return `No onboarding artifacts found under ${result.profileRoot}.`;
  }
  return [
    'Onboarding reset complete.',
    `Profile root: ${result.profileRoot}`,
    'Removed:',
    formatPathList(result.profileRoot, result.removed),
    '',
    'Next step: run `pnpm onboard` or `pnpm onboard apply --identity <path>` to start again.',
  ].join('\n');
}

export async function main(
  args: string[] = [],
  print: (value: unknown) => void = () => undefined
): Promise<void> {
  const force = args.includes('--force');
  const json = args.includes('--json');
  const dryRun = args.includes('--dry-run') || args.includes('--check');

  if (args.includes('--help') || args.includes('-h')) {
    print('Usage: pnpm onboard reset [--force] [--json] [--dry-run] [--check]');
    return;
  }

  const result = await resetOnboardingArtifacts({ force, dryRun, print: (value) => print(value) });
  print(json ? result : formatResetSummary(result));
}

if (
  isDirectScript(import.meta.url, 'onboarding_reset.ts') ||
  isDirectScript(import.meta.url, 'onboarding_reset.js')
)
  void defineScript({
    name: 'onboard reset',
    flags: ['json', 'dry-run', 'check'],
    run(context) {
      return main(context.argv, context.print);
    },
  })();
