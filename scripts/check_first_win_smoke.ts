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
      'active/shared/tmp/first-win-session.png',
    ],
  },
  {
    file: 'docs/QUICKSTART.md',
    required: [
      'pnpm doctor',
      'pnpm pipeline --input pipelines/voice-hello.json',
      'pnpm pipeline --input pipelines/verify-session.json',
      'active/shared/tmp/first-win-session.png',
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
      '"first-win"',
      'active/shared/tmp/first-win-session.png',
    ],
  },
];

function readJson(file: string): any | null {
  const abs = pathResolver.rootResolve(file);
  try {
    return JSON.parse(String(safeReadFile(abs, { encoding: 'utf8' }) || ''));
  } catch {
    return null;
  }
}

export function validateVerifySessionPipeline(pipeline: any): string[] {
  const violations: string[] = [];
  const steps = Array.isArray(pipeline?.steps) ? pipeline.steps : [];
  const stepOps = new Set(steps.map((step: any) => String(step?.op || '')));
  if (pipeline?.options?.headless !== true) {
    violations.push('pipelines/verify-session.json: options.headless must be true for clean first-win smoke');
  }
  const userDataDir = String(pipeline?.options?.user_data_dir || '');
  if (!userDataDir.startsWith('active/shared/tmp/')) {
    violations.push('pipelines/verify-session.json: user_data_dir must stay under active/shared/tmp/');
  }
  if (!stepOps.has('browser:goto')) {
    violations.push('pipelines/verify-session.json: missing browser:goto first-win navigation');
  }
  if (!stepOps.has('browser:evaluate')) {
    violations.push('pipelines/verify-session.json: missing browser:evaluate state capture');
  }
  if (!stepOps.has('browser:screenshot')) {
    violations.push('pipelines/verify-session.json: missing browser:screenshot artifact capture');
  }
  if (!stepOps.has('browser:close_session')) {
    violations.push('pipelines/verify-session.json: missing browser:close_session cleanup step');
  }
  const gotoStep = steps.find((step: any) => step?.op === 'browser:goto');
  const rawGotoUrl = String(gotoStep?.params?.url || '');
  const defaultTargetUrl = String(pipeline?.context?.TARGET_URL || pipeline?.inputs?.TARGET_URL?.default || '');
  const gotoUrl = rawGotoUrl.includes('{{TARGET_URL}}')
    ? defaultTargetUrl
    : rawGotoUrl || defaultTargetUrl;
  if (!gotoUrl.includes('data:text/html')) {
    violations.push('pipelines/verify-session.json: first-win navigation must use a local data URL');
  }
  if (!String(pipeline?.context?.TARGET_URL || '').includes('data:text/html')) {
    violations.push('pipelines/verify-session.json: context.TARGET_URL must provide the local data URL default');
  }
  const screenshotStep = steps.find((step: any) => step?.op === 'browser:screenshot');
  if (screenshotStep?.params?.path !== 'active/shared/tmp/first-win-session.png') {
    violations.push('pipelines/verify-session.json: screenshot path must be active/shared/tmp/first-win-session.png');
  }
  return violations;
}

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
  const verifySession = readJson('pipelines/verify-session.json');
  if (!verifySession) {
    violations.push('pipelines/verify-session.json: invalid JSON');
  } else {
    violations.push(...validateVerifySessionPipeline(verifySession));
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
