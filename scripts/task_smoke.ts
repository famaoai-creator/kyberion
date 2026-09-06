#!/usr/bin/env node
import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeWriteFile,
} from '@agent/core/secure-io';
import { nowIso } from '@agent/core/foundation';
import { describeTaskRun } from './task_run.js';
import { defineScript, isDirectScript } from './lib/harness.js';
import { loadTaskScenario, type TaskScenario } from './lib/task-scenario.js';

type SmokeAnswers = Record<string, Record<string, string>>;

const SMOKE_PROFILE_DIR = pathResolver.rootResolve('active/shared/tmp/task-smoke');
const SCENARIO_DIR = pathResolver.rootResolve('knowledge/product/task-scenarios');

const BUILTIN_ANSWERS: SmokeAnswers = {
  'email-filter-and-organize': {
    利用するメールサービスとアカウントは何か: 'Gmail / primary account',
    対象とする検索クエリやキーワードは何か: 'from:notifications.example.com is:unread',
    どの分類ルールでメールを振り分けるか: '通知メールを運用ラベルへ分類',
    移動先のラベル名またはフォルダ名は何か: 'Operations/Notifications',
    '受信トレイからアーカイブするか。削除は別途承認するか': 'アーカイブする。削除は明示承認する',
  },
  'daily-email-triage': {
    重要メールとして扱う送信元や条件は何か: '顧客、役員、採用候補者からのメール',
    返信下書きに含めてよいカテゴリや情報の範囲はどこまでか: '日程調整と受領確認のみ',
    送信前に人間承認が必要になる条件は何か: '外部送信は常に承認',
    返信トーンはどの程度まで自動化してよいか: '丁寧で簡潔',
  },
};

function scenarioPath(scenarioId: string): string {
  return assertSafeRepositoryPath(path.join(SCENARIO_DIR, `${scenarioId}.json`), {
    allowMissingLeaf: true,
  });
}

function loadScenario(scenarioId: string): TaskScenario {
  const filePath = scenarioPath(scenarioId);
  if (!safeExistsSync(filePath)) {
    throw new Error(`Unknown TaskScenario: ${scenarioId}`);
  }
  if (!safeLstat(filePath).isFile()) {
    throw new Error(`TaskScenario must be a regular file: ${scenarioId}`);
  }
  return loadTaskScenario(filePath);
}

function buildSmokeProfile(
  scenario: TaskScenario,
  answers: Record<string, string>
): Record<string, unknown> {
  const firstRunAnswers: Record<string, string | null> = {};
  for (const question of scenario.first_run.questions) {
    firstRunAnswers[question] = answers[question] ?? null;
  }

  return {
    scenario_id: scenario.id,
    scenario_title: scenario.title,
    created_at: nowIso(),
    answers,
    first_run_answers: firstRunAnswers,
    repeat_run: scenario.repeat_run,
    approval_boundary: scenario.approval_boundary,
  };
}

function profilePathForScenario(scenarioId: string): string {
  return assertSafeRepositoryPath(path.join(SMOKE_PROFILE_DIR, `${scenarioId}.json`), {
    allowMissingLeaf: true,
  });
}

export async function main(
  argv: string[] = [],
  print: (value: unknown) => void = () => undefined
): Promise<void> {
  const scenarioId = argv.find((arg) => !arg.startsWith('--'));
  if (!scenarioId) {
    throw new Error('Usage: pnpm kyberion task smoke <scenario-id>');
  }

  const scenario = loadScenario(scenarioId);
  const answers = BUILTIN_ANSWERS[scenario.id];
  if (!answers) {
    throw new Error(`No built-in smoke answers for ${scenario.id}`);
  }

  const profilePath = profilePathForScenario(scenario.id);
  safeMkdir(assertSafeRepositoryPath(SMOKE_PROFILE_DIR, { allowMissingLeaf: true }), {
    recursive: true,
  });
  safeWriteFile(profilePath, `${JSON.stringify(buildSmokeProfile(scenario, answers), null, 2)}\n`);

  print(`TaskScenario smoke: ${scenario.id}`);
  print('Phase 1: list');
  print(`- Title: ${scenario.title}`);
  print(`- Profile target: ${profilePath}`);
  print('Phase 2: init');
  print(`- Fixture answers loaded: ${Object.keys(answers).length}`);
  print('Phase 3: run');
  print(describeTaskRun(scenario.id, profilePath, { allowExternalProfilePath: true }));
  print(`TaskScenario smoke passed: ${scenario.id}`);
}

const script = defineScript({
  name: 'task:smoke',
  flags: [],
  run: ({ argv, print }) => main(argv, print),
});
if (
  isDirectScript(import.meta.url, 'task_smoke.ts') ||
  isDirectScript(import.meta.url, 'task_smoke.js')
) {
  void script();
}
