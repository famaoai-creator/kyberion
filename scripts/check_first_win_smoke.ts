#!/usr/bin/env node
import * as path from 'node:path';
import { pathResolver, safeExistsSync, safeReadFile } from '@agent/core';

interface SmokeRule {
  file: string;
  required: string[];
}

const ROOT = pathResolver.rootDir();

const RULES: SmokeRule[] = [
  {
    file: 'README.md',
    required: [
      'pnpm doctor',
      'pnpm pipeline --input pipelines/voice-hello.json',
      'pnpm pipeline --input pipelines/verify-session.json',
    ],
  },
  {
    file: 'docs/QUICKSTART.md',
    required: [
      'pnpm doctor',
      'pnpm pipeline --input pipelines/voice-hello.json',
      'pnpm pipeline --input pipelines/verify-session.json',
    ],
  },
  {
    file: 'docs/user/README.md',
    required: [
      'QUICKSTART.md',
      'first working smoke',
    ],
  },
  {
    file: 'docs/developer/VOICE_FIRST_WIN.md',
    required: [
      'pipelines/voice-hello.json',
      'system:native_tts_speak',
    ],
  },
  {
    file: 'pipelines/voice-hello.json',
    required: [
      '"pipeline_id": "voice-hello"',
      '"first-win"',
      '"tier-0"',
    ],
  },
  {
    file: 'pipelines/verify-session.json',
    required: [
      '"pipeline_id": "verify-session"',
      'enterprise-login-success.png',
    ],
  },
];

export function checkFirstWinSmoke(): string[] {
  const violations: string[] = [];
  for (const rule of RULES) {
    const abs = pathResolver.rootResolve(rule.file);
    if (!safeExistsSync(abs)) {
      violations.push(`${rule.file}: missing`);
      continue;
    }
    const text = String(safeReadFile(abs, { encoding: 'utf8' }) || '');
    for (const needle of rule.required) {
      if (!text.includes(needle)) {
        violations.push(`${rule.file}: missing "${needle}"`);
      }
    }
  }
  return violations;
}

export function main(): void {
  const violations = checkFirstWinSmoke();
  if (violations.length > 0) {
    console.error('[check:first-win-smoke] violations detected:');
    for (const violation of violations) {
      console.error(`- ${violation}`);
    }
    process.exit(1);
  }
  console.log('[check:first-win-smoke] OK');
}

const isDirectRun = process.argv[1] && /check_first_win_smoke\.(ts|js)$/.test(process.argv[1]);
if (isDirectRun) {
  main();
}
