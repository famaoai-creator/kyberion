#!/usr/bin/env node
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  pathResolver,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeWriteFile,
} from '@agent/core';
import { describeTaskRun } from './task_run.js';

type TaskScenario = {
  id: string;
  title: string;
  first_run: { questions: string[] };
  repeat_run: { profile_input?: string };
  approval_boundary: { required_for: string[]; default_action: 'draft-only' | 'notify-only' | 'requires-human-approval' };
};

type SmokeAnswers = Record<string, Record<string, string>>;

const PROFILE_DIR = pathResolver.rootResolve('knowledge/personal/task-profiles');
const SCENARIO_DIR = pathResolver.rootResolve('knowledge/product/task-scenarios');

const BUILTIN_ANSWERS: SmokeAnswers = {
  'daily-email-triage': {
    '重要メールとして扱う送信元や条件は何か': '顧客、役員、採用候補者からのメール',
    '返信下書きに含めてよいカテゴリや情報の範囲はどこまでか': '日程調整と受領確認のみ',
    '送信前に人間承認が必要になる条件は何か': '外部送信は常に承認',
    '返信トーンはどの程度まで自動化してよいか': '丁寧で簡潔',
  },
};

function scenarioPath(scenarioId: string): string {
  return path.join(SCENARIO_DIR, `${scenarioId}.json`);
}

function loadScenario(scenarioId: string): TaskScenario {
  const filePath = scenarioPath(scenarioId);
  if (!safeExistsSync(filePath)) {
    throw new Error(`Unknown TaskScenario: ${scenarioId}`);
  }
  return JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string) as TaskScenario;
}

function buildSmokeProfile(scenario: TaskScenario, answers: Record<string, string>): Record<string, unknown> {
  const firstRunAnswers: Record<string, string | null> = {};
  for (const question of scenario.first_run.questions) {
    firstRunAnswers[question] = answers[question] ?? null;
  }

  return {
    scenario_id: scenario.id,
    scenario_title: scenario.title,
    created_at: new Date().toISOString(),
    answers,
    first_run_answers: firstRunAnswers,
    repeat_run: scenario.repeat_run,
    approval_boundary: scenario.approval_boundary,
  };
}

function profilePathForScenario(scenarioId: string): string {
  return pathResolver.rootResolve(`knowledge/personal/task-profiles/${scenarioId}.json`);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const scenarioId = argv.find((arg) => !arg.startsWith('--'));
  if (!scenarioId) {
    throw new Error('Usage: pnpm task:smoke <scenario-id>');
  }

  const scenario = loadScenario(scenarioId);
  const answers = BUILTIN_ANSWERS[scenario.id];
  if (!answers) {
    throw new Error(`No built-in smoke answers for ${scenario.id}`);
  }

  const profilePath = profilePathForScenario(scenario.id);
  safeMkdir(PROFILE_DIR, { recursive: true });
  safeWriteFile(profilePath, `${JSON.stringify(buildSmokeProfile(scenario, answers), null, 2)}\n`);

  console.log(`TaskScenario smoke: ${scenario.id}`);
  console.log('Phase 1: list');
  console.log(`- Title: ${scenario.title}`);
  console.log(`- Profile target: ${profilePath}`);
  console.log('Phase 2: init');
  console.log(`- Fixture answers loaded: ${Object.keys(answers).length}`);
  console.log('Phase 3: run');
  console.log(describeTaskRun(scenario.id, profilePath));
  console.log(`TaskScenario smoke passed: ${scenario.id}`);
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  main().catch((err) => {
    console.error(err?.message ?? String(err));
    process.exit(1);
  });
}
