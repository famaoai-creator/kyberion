#!/usr/bin/env node
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeReadFile } from '@agent/core/secure-io';
import { readValidatedPipelineAdf } from './refactor/adf-input.js';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

interface SmokeRule {
  file: string;
  required: string[];
}

const FIRST_WIN_DOCUMENTS = ['README.md', 'docs/QUICKSTART.md', 'docs/INITIALIZATION.md'] as const;
const CANONICAL_FIRST_WIN_COMMANDS = [
  'pnpm install',
  'pnpm build',
  'pnpm env:bootstrap --manifest kyberion-toolchain',
  'pnpm doctor',
  'pnpm pipeline --input pipelines/verify-session.json',
] as const;

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
    required: ['QUICKSTART.md', 'first working smoke'],
  },
  {
    file: 'docs/user/TROUBLESHOOTING.md',
    required: [
      'pnpm setup:report --persona first-time-user',
      'pnpm surfaces repair',
      'pnpm doctor',
    ],
  },
  {
    file: 'docs/developer/VOICE_FIRST_WIN.md',
    required: ['pipelines/voice-hello.json', 'system:native_tts_speak'],
  },
  {
    file: 'pipelines/voice-hello.json',
    required: ['"pipeline_id": "voice-hello"', '"first-win"', '"tier-0"'],
  },
  {
    file: 'pipelines/verify-session.json',
    required: [
      '"pipeline_id": "verify-session"',
      '"first-win"',
      'active/shared/tmp/first-win-session.png',
      'verify-session-fallback.json',
    ],
  },
  {
    file: 'pipelines/verify-session-fallback.json',
    required: [
      '"pipeline_id": "verify-session-fallback"',
      'first-win-fallback.txt',
      'non-browser artifact',
    ],
  },
  {
    file: 'pipelines/first-win-lifecycle-weekly.json',
    required: [
      'first-win-lifecycle-weekly',
      'No state is applied',
      'core:run_first_win_lifecycle',
      'lifecycle-dry-run',
    ],
  },
];

function readValidatedPipeline(file: string): any | null {
  try {
    return readValidatedPipelineAdf(file);
  } catch {
    return null;
  }
}

export function validateVerifySessionPipeline(pipeline: any): string[] {
  const violations: string[] = [];
  const steps = Array.isArray(pipeline?.steps) ? pipeline.steps : [];
  const stepOps = new Set(steps.map((step: any) => String(step?.op || '')));
  if (pipeline?.options?.headless !== true) {
    violations.push(
      'pipelines/verify-session.json: options.headless must be true for clean first-win smoke'
    );
  }
  const userDataDir = String(pipeline?.options?.user_data_dir || '');
  if (!userDataDir.startsWith('active/shared/tmp/')) {
    violations.push(
      'pipelines/verify-session.json: user_data_dir must stay under active/shared/tmp/'
    );
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
  const defaultTargetUrl = String(
    pipeline?.context?.TARGET_URL || pipeline?.inputs?.TARGET_URL?.default || ''
  );
  const gotoUrl = rawGotoUrl.includes('{{TARGET_URL}}')
    ? defaultTargetUrl
    : rawGotoUrl || defaultTargetUrl;
  if (!gotoUrl.includes('data:text/html')) {
    violations.push(
      'pipelines/verify-session.json: first-win navigation must use a local data URL'
    );
  }
  if (!String(pipeline?.context?.TARGET_URL || '').includes('data:text/html')) {
    violations.push(
      'pipelines/verify-session.json: context.TARGET_URL must provide the local data URL default'
    );
  }
  const screenshotStep = steps.find((step: any) => step?.op === 'browser:screenshot');
  if (screenshotStep?.params?.path !== 'active/shared/tmp/first-win-session.png') {
    violations.push(
      'pipelines/verify-session.json: screenshot path must be active/shared/tmp/first-win-session.png'
    );
  }
  if (pipeline?.fallback_pipeline !== 'pipelines/verify-session-fallback.json') {
    violations.push(
      'pipelines/verify-session.json: fallback_pipeline must point to pipelines/verify-session-fallback.json'
    );
  }
  return violations;
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

export function validateFirstWinLifecyclePipeline(pipeline: unknown): string[] {
  const violations: string[] = [];
  const record = jsonRecord(pipeline);
  const schedule = jsonRecord(record.schedule);
  const steps = Array.isArray(record.steps) ? record.steps.map(jsonRecord) : [];
  if (record.pipeline_id !== 'first-win-lifecycle-weekly') {
    violations.push(
      'pipelines/first-win-lifecycle-weekly.json: pipeline_id must be first-win-lifecycle-weekly'
    );
  }
  if (
    schedule.enabled !== true ||
    schedule.cron !== '0 9 * * 1' ||
    schedule.timezone !== 'Asia/Tokyo'
  ) {
    violations.push(
      'pipelines/first-win-lifecycle-weekly.json: schedule must be enabled weekly at 09:00 Monday Asia/Tokyo'
    );
  }
  const dryRunStep = steps.find((step) => step.id === 'lifecycle-dry-run');
  // The weekly lifecycle smoke runs through the typed engine op
  // `core:run_first_win_lifecycle`, which always executes the dry-run JSON
  // smoke (see runInlineFirstWinLifecycle). A shell wrapper around
  // dist/scripts/first_win_lifecycle_smoke.js is no longer accepted.
  if (dryRunStep?.op !== 'core:run_first_win_lifecycle') {
    violations.push(
      'pipelines/first-win-lifecycle-weekly.json: lifecycle-dry-run must execute the explicit dry-run JSON smoke command'
    );
  }
  return violations;
}

export function extractCanonicalFirstWinCommands(source: string): string[] | null {
  const markerIndex = source.indexOf('# kyberion-first-win');
  if (markerIndex < 0) return null;
  const afterMarker = source.slice(markerIndex + '# kyberion-first-win'.length);
  const block = afterMarker.match(/```bash\r?\n([\s\S]*?)\r?\n```/u)?.[1];
  if (!block) return null;
  return block
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

export function validateCanonicalFirstWinDocumentation(
  documents: ReadonlyArray<{ file: string; source: string }> = FIRST_WIN_DOCUMENTS.map((file) => ({
    file,
    source: String(safeReadFile(pathResolver.rootResolve(file), { encoding: 'utf8' }) || ''),
  }))
): string[] {
  const violations: string[] = [];
  let canonical: string[] | null = null;

  for (const document of documents) {
    const commands = extractCanonicalFirstWinCommands(document.source);
    if (!commands) {
      violations.push(`${document.file}: missing canonical # kyberion-first-win bash block`);
      continue;
    }
    if (commands.length !== CANONICAL_FIRST_WIN_COMMANDS.length) {
      violations.push(
        `${document.file}: canonical first-win block must contain exactly ${CANONICAL_FIRST_WIN_COMMANDS.length} commands`
      );
      continue;
    }
    for (const [index, expected] of CANONICAL_FIRST_WIN_COMMANDS.entries()) {
      if (commands[index] !== expected) {
        violations.push(
          `${document.file}: canonical first-win command ${index + 1} must be "${expected}"`
        );
      }
    }
    if (!canonical) canonical = commands;
    else if (JSON.stringify(commands) !== JSON.stringify(canonical)) {
      violations.push(
        `${document.file}: canonical first-win commands differ from the first document`
      );
    }
  }
  return violations;
}

export function checkFirstWinSmoke(): string[] {
  const violations: string[] = [];
  violations.push(...validateCanonicalFirstWinDocumentation());
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
  const verifySession = readValidatedPipeline('pipelines/verify-session.json');
  if (!verifySession) {
    violations.push('pipelines/verify-session.json: invalid JSON');
  } else {
    violations.push(...validateVerifySessionPipeline(verifySession));
  }
  const lifecycle = readValidatedPipeline('pipelines/first-win-lifecycle-weekly.json');
  if (!lifecycle) {
    violations.push('pipelines/first-win-lifecycle-weekly.json: invalid JSON');
  } else {
    violations.push(...validateFirstWinLifecyclePipeline(lifecycle));
  }
  return violations;
}

export const runCheckFirstWinSmoke = defineScript({
  name: 'check:first-win-smoke',
  flags: [],
  run(context) {
    const violations = checkFirstWinSmoke();
    if (violations.length > 0) {
      throw new ScriptExitError(
        1,
        ['violations detected:', ...violations.map((violation) => `- ${violation}`)].join('\n')
      );
    }
    context.print('[check:first-win-smoke] OK');
    return { violations };
  },
});

if (
  isDirectScript(import.meta.url, 'check_first_win_smoke.ts') ||
  isDirectScript(import.meta.url, 'check_first_win_smoke.js')
)
  void runCheckFirstWinSmoke();
