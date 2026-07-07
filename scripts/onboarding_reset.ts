#!/usr/bin/env node
import * as path from 'node:path';
import * as readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { resolveActiveProfileRoot, safeExistsSync, safeRmSync } from '@agent/core';

export interface OnboardingResetOptions {
  force?: boolean;
  profileRoot?: string;
  confirm?: () => Promise<boolean>;
}

export interface OnboardingResetResult {
  profileRoot: string;
  removed: string[];
}

function onboardingArtifactPaths(profileRoot: string): string[] {
  return [
    path.join(profileRoot, 'onboarding'),
    path.join(profileRoot, 'my-identity.json'),
    path.join(profileRoot, 'my-vision.md'),
    path.join(profileRoot, 'agent-identity.json'),
    path.join(profileRoot, 'connections'),
    path.join(profileRoot, 'tenants'),
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
    return { profileRoot, removed: [] };
  }

  let proceed = options.force ?? false;
  if (!proceed) {
    if (options.confirm) {
      proceed = await options.confirm();
    } else if (process.stdin.isTTY && process.stdout.isTTY) {
      console.log(
        `About to reset onboarding artifacts under: ${path.relative(process.cwd(), profileRoot)}`
      );
      console.log(formatPathList(profileRoot, existingTargets));
      proceed = await createPrompt();
    } else {
      throw new Error('onboard:reset requires a TTY confirmation or --force');
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
  if (result.removed.length === 0) {
    return `No onboarding artifacts found under ${result.profileRoot}.`;
  }
  return [
    'Onboarding reset complete.',
    `Profile root: ${result.profileRoot}`,
    'Removed:',
    formatPathList(result.profileRoot, result.removed),
    '',
    'Next step: run `pnpm onboard` or `pnpm onboard:apply --identity <path>` to start again.',
  ].join('\n');
}

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const json = args.includes('--json');

  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: pnpm onboard:reset [--force] [--json]');
    return;
  }

  const result = await resetOnboardingArtifacts({ force });
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  console.log(formatResetSummary(result));
}

const isDirect =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
