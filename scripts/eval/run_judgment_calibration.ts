/**
 * Judgment calibration evaluation & fitter CLI.
 *
 * Runs `evaluateCallSite()` over a labelled suite (`error`, `work_shape`,
 * `semantic_decide`, `error-corpus`, `routing`, or a custom `--cases` JSON file)
 * through the shared `judgment-backend` seam, evaluates stability and residual
 * ECE via `proposeCalibrationEntry()`, and optionally merges an ACCEPTED fit
 * into `knowledge/product/governance/judgment-calibration.json`.
 *
 * Unaccepted fits (insufficient samples, thin confidence bins, unstable runs,
 * or excessive residual ECE) are never written even when `--apply` is passed.
 */

import * as path from 'node:path';
import { z } from 'zod';
import { pathResolver } from '@agent/core/path-resolver';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeWriteFile,
} from '@agent/core/secure-io';
import {
  BUILTIN_JUDGMENT_PROVIDER,
  ensureJudgmentBackendsRegistered,
  errorCategoryQuestion,
  ERROR_CATEGORY_QUESTION,
  evaluateCallSite,
  exportErrorJudgmentCorpus,
  exportRoutingCorpus,
  listJudgmentBackends,
  listOptionalJudgmentProviders,
  proposeCalibrationEntry,
  resetJudgmentBackends,
  SEMANTIC_DECIDE_QUESTION,
  TASK_TIER_QUESTION,
  taskTierQuestion,
  type CallSiteCase,
  type CallSiteEvaluation,
  type CalibrationProposal,
  type JudgmentCalibrationEntry,
  type JudgmentQuestion,
  type TierLevel,
} from '@agent/core';
import { ORGANIZATION_WORK_SHAPE_QUESTION } from '@agent/core/organization';
import { defineScript, isDirectScript, ScriptExitError } from '../lib/harness.js';

export type BuiltInCalibrationSuiteName =
  'error' | 'work_shape' | 'semantic_decide' | 'error-corpus' | 'routing';

const VALID_SUITES: readonly BuiltInCalibrationSuiteName[] = [
  'error',
  'work_shape',
  'semantic_decide',
  'error-corpus',
  'routing',
];

export interface CalibrationSuiteSpec {
  questionId: string;
  question: (testCase: CallSiteCase) => JudgmentQuestion;
  cases: CallSiteCase[];
}

export interface RunJudgmentCalibrationOptions {
  provider: string;
  suite?: BuiltInCalibrationSuiteName;
  routingLedgerPath?: string;
  customSpec?: CalibrationSuiteSpec;
  tier?: TierLevel;
  tenantSlug?: string;
  repeats?: number;
  minSamples?: number;
  minPerBin?: number;
  maxEce?: number;
  requireDeterministic?: boolean;
  apply?: boolean;
  calibrationFilePath?: string;
  skipBootstrap?: boolean;
}

export interface RunJudgmentCalibrationResult {
  providerId: string;
  questionId: string;
  evaluation: CallSiteEvaluation;
  proposal: CalibrationProposal;
  applied: boolean;
  calibrationPath?: string;
}

const WORK_SHAPE_DESCRIPTIONS: Record<string, string> = {
  incident_response: 'Urgent production incident, outage, or error mitigation',
  routine_operation: 'Scheduled recurring business or operational reporting/billing task',
  service_operation: 'Ongoing customer or internal service operation and support maintenance',
  solution_project: 'Building, designing, or introducing a new feature, tool, or project',
  governance_cadence: 'Budget approval, compliance review, policy governance, or audit cadence',
  exploratory_research: 'Investigating, comparing options, or researching unknowns before acting',
};

const customCasesSchema = z.object({
  questionId: z.string().trim().min(1),
  question: z.object({
    kind: z.literal('choice'),
    id: z.string().trim().min(1).optional(),
    options: z.array(z.string().min(1)).min(2),
    optionDescriptions: z.record(z.string(), z.string()).optional(),
    instructions: z.string().min(1).optional(),
  }),
  cases: z
    .array(
      z.object({
        id: z.string().min(1),
        state: z.string().min(1),
        expected: z.union([z.string(), z.boolean(), z.number()]),
      })
    )
    .min(1),
});

export function buildBuiltInCallSiteSuite(
  name: BuiltInCalibrationSuiteName,
  options: { routingLedgerPath?: string } = {}
): CalibrationSuiteSpec {
  if (name === 'error' || name === 'error-corpus') {
    const q = errorCategoryQuestion();
    if (name === 'error-corpus') {
      const reconciled = exportErrorJudgmentCorpus().filter((item) =>
        Boolean(item.expected_category)
      );
      if (reconciled.length === 0) {
        throw new ScriptExitError(
          2,
          'No reconciled items in unclassified-error-registry — reconcile unmatched errors first | next: run with --suite error or --cases <corpus.json>'
        );
      }
      return {
        questionId: ERROR_CATEGORY_QUESTION,
        question: () => q,
        cases: reconciled.map((item, idx) => ({
          id: `err-corpus-${idx + 1}`,
          state: item.message_excerpt,
          expected: item.expected_category!,
        })),
      };
    }
    return {
      questionId: ERROR_CATEGORY_QUESTION,
      question: () => q,
      cases: [
        {
          id: 'err-perm-1',
          state: '[RESOURCE_PATH_SCOPE] resource path /etc/passwd is outside repository root',
          expected: 'permission_denied',
        },
        {
          id: 'err-auth-1',
          state: 'HTTP 401 Unauthorized: invalid API bearer token expired',
          expected: 'auth',
        },
        {
          id: 'err-rate-1',
          state: 'HTTP 429 Too Many Requests: quota rate limit exceeded, retry after 30s',
          expected: 'rate_limit',
        },
        {
          id: 'err-timeout-1',
          state: 'Operation aborted: request timed out after 15000ms',
          expected: 'timeout',
        },
        {
          id: 'err-net-1',
          state: 'ECONNREFUSED 127.0.0.1:443 DNS lookup failed for api.example.com',
          expected: 'network',
        },
        {
          id: 'err-secret-1',
          state: 'CREDENTIAL_KEY_UNAVAILABLE: missing keychain secret for gemini-api',
          expected: 'missing_secret',
        },
      ],
    };
  }

  if (name === 'routing') {
    if (!options.routingLedgerPath?.trim()) {
      throw new ScriptExitError(
        2,
        "Suite 'routing' requires --routing-ledger <path> — no global cross-tenant ledger exists | next: pass --routing-ledger active/missions/<tier>/<id>/evidence/routing-outcomes.jsonl"
      );
    }
    const safeLedgerPath = assertSafeRepositoryPath(
      pathResolver.rootResolve(options.routingLedgerPath)
    );
    const items = exportRoutingCorpus(safeLedgerPath);
    if (items.length === 0) {
      throw new ScriptExitError(
        2,
        `No attempted routing outcomes found in ${options.routingLedgerPath} — record task dispatches before calibrating | next: pass another ledger or --cases <corpus.json>`
      );
    }
    const q = taskTierQuestion();
    return {
      questionId: TASK_TIER_QUESTION,
      question: () => q,
      cases: items.map((item, idx) => ({
        id: `routing-${idx + 1}`,
        state: item.task_excerpt,
        expected: item.expected_tier,
      })),
    };
  }

  if (name === 'work_shape') {
    const q: JudgmentQuestion = {
      kind: 'choice',
      id: ORGANIZATION_WORK_SHAPE_QUESTION,
      options: Object.keys(WORK_SHAPE_DESCRIPTIONS),
      optionDescriptions: WORK_SHAPE_DESCRIPTIONS,
      instructions: 'Classify the organization work shape of this request.',
    };
    return {
      questionId: ORGANIZATION_WORK_SHAPE_QUESTION,
      question: () => q,
      cases: [
        {
          id: 'ws-incident-1',
          state: '本番環境でAPIが500エラーを返しているので至急原因調査と復旧をお願いしたい', // i18n-exempt: synthetic Japanese classification benchmark fixture
          expected: 'incident_response',
        },
        {
          id: 'ws-routine-1',
          state: '今月の月次請求書と利用明細レポートを作成してください', // i18n-exempt: synthetic Japanese classification benchmark fixture
          expected: 'routine_operation',
        },
        {
          id: 'ws-gov-1',
          state: '来期予算の決裁承認とガバナンス基準のレビューをお願いします', // i18n-exempt: synthetic Japanese classification benchmark fixture
          expected: 'governance_cadence',
        },
        {
          id: 'ws-proj-1',
          state: '新しい顧客向けダッシュボード機能を設計して実装したい', // i18n-exempt: synthetic Japanese classification benchmark fixture
          expected: 'solution_project',
        },
        {
          id: 'ws-research-1',
          state: '軽量なSystem-1判定モデルの精度とレイテンシを比較調査してください', // i18n-exempt: synthetic Japanese classification benchmark fixture
          expected: 'exploratory_research',
        },
      ],
    };
  }

  const semanticOptions = ['retry', 'escalate', 'abort'] as const;
  const semanticDescriptions: Record<string, string> = {
    retry: 'Transient failure or temporary timeout where retrying the exact operation is safe',
    escalate:
      'Ambiguous failure, policy block, or human approval boundary requiring operator review',
    abort:
      'Permanent invalid input, authentication rejection, or non-recoverable configuration error',
  };
  const q: JudgmentQuestion = {
    kind: 'choice',
    id: SEMANTIC_DECIDE_QUESTION,
    options: [...semanticOptions],
    optionDescriptions: semanticDescriptions,
    instructions: 'Select the safest next automation action for the observed state.',
  };
  return {
    questionId: SEMANTIC_DECIDE_QUESTION,
    question: () => q,
    cases: [
      {
        id: 'sd-retry-1',
        state:
          'HTTP 503 Service Unavailable from upstream endpoint; safe idempotent read operation',
        expected: 'retry',
      },
      {
        id: 'sd-escalate-1',
        state: 'Production deploy requires human approval under governance policy gate',
        expected: 'escalate',
      },
      {
        id: 'sd-abort-1',
        state:
          'Invalid JSON payload schema: required field tenant_id is missing and cannot be guessed',
        expected: 'abort',
      },
      {
        id: 'sd-retry-2',
        state: 'Socket hang up ECONNRESET during read-only status poll',
        expected: 'retry',
      },
    ],
  };
}

export function mergeCalibrationEntry(
  existingJson: string | undefined,
  providerId: string,
  entry: JudgmentCalibrationEntry
): string {
  const parsed = existingJson?.trim()
    ? (JSON.parse(existingJson) as {
        version?: string;
        providers?: Record<string, JudgmentCalibrationEntry>;
      })
    : {};
  const providers =
    parsed.providers && typeof parsed.providers === 'object' ? { ...parsed.providers } : {};
  const prev = providers[providerId];
  const mergedQuestions = Array.from(new Set([...(prev?.questions ?? []), ...entry.questions]));
  const mergedTemperatures = {
    ...(prev?.temperatures ?? {}),
    ...(entry.temperatures ?? {}),
  };
  providers[providerId] = {
    questions: mergedQuestions,
    fitted_from: entry.fitted_from,
    fitted_at: entry.fitted_at,
    temperatures: mergedTemperatures,
  };
  return (
    JSON.stringify(
      {
        version: parsed.version || '1.0.0',
        providers,
      },
      null,
      2
    ) + '\n'
  );
}

export async function runJudgmentCalibration(
  options: RunJudgmentCalibrationOptions
): Promise<RunJudgmentCalibrationResult> {
  if (!options.skipBootstrap) {
    const boot = ensureJudgmentBackendsRegistered({
      providers: options.provider === BUILTIN_JUDGMENT_PROVIDER ? '' : options.provider,
    });
    if (boot.refused.length > 0) {
      throw new Error(
        `Unknown judgment provider '${options.provider}': ${boot.refused.map((r) => r.reason).join('; ')}`
      );
    }
  }
  const hasProvider = listJudgmentBackends().some((b) => b.judgment_id === options.provider);
  if (!hasProvider && options.provider !== BUILTIN_JUDGMENT_PROVIDER) {
    throw new Error(`Judgment provider '${options.provider}' is not registered.`);
  }

  const spec =
    options.customSpec ??
    buildBuiltInCallSiteSuite(options.suite ?? 'semantic_decide', {
      routingLedgerPath: options.routingLedgerPath,
    });
  const evaluation = await evaluateCallSite({
    questionId: spec.questionId,
    question: spec.question,
    cases: spec.cases,
    tier: options.tier ?? 'public',
    ...(options.tenantSlug ? { tenantSlug: options.tenantSlug } : {}),
    repeats: options.repeats ?? 3,
  });

  const resolvedProviderId = evaluation.providerId || options.provider;
  const providerMismatch =
    evaluation.answered > 0 &&
    Boolean(evaluation.providerId) &&
    evaluation.providerId !== options.provider;

  const samples = evaluation.results
    .filter((row) => Number.isFinite(row.confidence))
    .map((row) => ({
      id: row.id,
      confidence: row.confidence,
      correct: row.correct,
      stable: row.stable,
    }));

  const rawProposal = proposeCalibrationEntry({
    providerId: resolvedProviderId,
    questionId: spec.questionId,
    samples,
    fittedFrom: options.customSpec
      ? `custom:${spec.questionId}`
      : `builtin:${options.suite ?? 'semantic_decide'}`,
    minSamples: options.minSamples,
    minPerBin: options.minPerBin,
    maxEce: options.maxEce,
    requireDeterministic: options.requireDeterministic ?? true,
  });

  const proposal: CalibrationProposal = providerMismatch
    ? {
        ...rawProposal,
        accepted: false,
        reason: `provider mismatch: requested '${options.provider}' but '${evaluation.providerId}' answered`,
      }
    : rawProposal;

  let applied = false;
  let calibrationPath: string | undefined;
  if (options.apply && proposal.accepted && proposal.entry) {
    const targetPath = assertSafeRepositoryPath(
      options.calibrationFilePath ??
        pathResolver.knowledge('product/governance/judgment-calibration.json'),
      { allowMissingLeaf: true }
    );
    const existing = safeExistsSync(targetPath)
      ? String(safeReadFile(targetPath, { encoding: 'utf8' }))
      : undefined;
    const nextContent = mergeCalibrationEntry(existing, resolvedProviderId, proposal.entry);
    safeMkdir(path.dirname(targetPath), { recursive: true });
    safeWriteFile(targetPath, nextContent);
    applied = true;
    calibrationPath = targetPath;
  }

  return {
    providerId: resolvedProviderId,
    questionId: spec.questionId,
    evaluation,
    proposal,
    applied,
    ...(calibrationPath ? { calibrationPath } : {}),
  };
}

function readArgValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  const next = argv[index + 1];
  if (next === undefined || next.startsWith('--')) return undefined;
  return next;
}

function parsePositiveIntFlag(argv: readonly string[], flag: string): number | undefined {
  const raw = readArgValue(argv, flag);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new ScriptExitError(2, `Invalid ${flag} '${raw}' — expected integer >= 1`);
  }
  return parsed;
}

function parseMaxEceFlag(argv: readonly string[]): number | undefined {
  const raw = readArgValue(argv, '--max-ece');
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
    throw new ScriptExitError(2, `Invalid --max-ece '${raw}' — expected number in (0, 1]`);
  }
  return parsed;
}

function formatSummaryText(result: RunJudgmentCalibrationResult): string {
  const acc = Number.isFinite(result.evaluation.accuracy)
    ? `${(result.evaluation.accuracy * 100).toFixed(1)}%`
    : 'n/a';
  const ece = Number.isFinite(result.proposal.report.ece)
    ? result.proposal.report.ece.toFixed(3)
    : 'n/a';
  const errors = result.evaluation.results
    .map((row) => row.error)
    .filter((msg): msg is string => Boolean(msg));
  const lines = [
    `Provider: ${result.providerId} | Question: ${result.questionId}`,
    `Answered: ${result.evaluation.answered}/${result.evaluation.results.length} | Accuracy: ${acc} | ECE: ${ece} | ConfidentlyWrong: ${result.evaluation.confidentlyWrong}/${result.evaluation.aboveFloor} | Unstable: ${result.evaluation.unstable}`,
  ];
  if (errors.length > 0) {
    lines.push(`Errors: ${errors.length} (first: ${errors[0]})`);
  }
  lines.push(
    `Calibration Proposal: accepted=${result.proposal.accepted} (${result.proposal.reason})`
  );
  lines.push(
    `Applied: ${result.applied}${result.calibrationPath ? ` (${result.calibrationPath})` : ''}`
  );
  if (!result.proposal.accepted) {
    lines.push(
      'Next: accumulate >= 100 labelled samples (>= 10 per confidence bin) using --suite error-corpus, --suite routing --routing-ledger <path>, or --cases <corpus.json> and re-run with --apply.'
    );
  }
  return lines.join('\n');
}

function usageText(): string {
  return [
    'Usage: node --import ./scripts/ts-loader.mjs scripts/eval/run_judgment_calibration.ts [options]',
    '',
    'Options:',
    `  --provider <${listOptionalJudgmentProviders().join('|')}>  Target provider (required)`,
    `  --suite <${VALID_SUITES.join('|')}>  Evaluation suite (default: semantic_decide)`,
    '  --routing-ledger <path>                     Mission routing-outcomes.jsonl (for --suite routing)',
    '  --cases <path.json>                         Custom labelled cases JSON',
    '  --tier <public|confidential|personal>       Data tier (default: public)',
    '  --tenant <slug>                             Optional tenant slug',
    '  --repeats <n>                               Repeated runs per case (default: 3)',
    '  --min-samples <n>                           Minimum labelled samples (default: 100)',
    '  --min-per-bin <n>                           Minimum samples per confidence bin (default: 10)',
    '  --max-ece <n>                               Max residual ECE threshold in (0, 1] (default: 0.1)',
    '  --no-require-deterministic                  Skip run-to-run stability gate',
    '  --apply                                     Write accepted fit into judgment-calibration.json',
    '  --output <path>                             Write report JSON/text to a safe repository path',
    '  --json                                      Emit JSON output',
    '  -h, --help                                  Show help',
  ].join('\n');
}

export async function main(
  argv: readonly string[] = [],
  print: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  options: { preserveRegisteredBackends?: boolean; calibrationFilePath?: string } = {}
): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    print(usageText());
    return 0;
  }

  const provider = readArgValue(argv, '--provider');
  const knownProviders = [...listOptionalJudgmentProviders(), BUILTIN_JUDGMENT_PROVIDER];
  if (!provider) {
    throw new ScriptExitError(
      2,
      `Missing required flag: --provider | known: ${knownProviders.join(', ')}`
    );
  }
  if (!knownProviders.includes(provider) && !options.preserveRegisteredBackends) {
    throw new ScriptExitError(
      2,
      `Unknown --provider '${provider}' | known: ${knownProviders.join(', ')}`
    );
  }

  const suiteRaw = (readArgValue(argv, '--suite') ??
    'semantic_decide') as BuiltInCalibrationSuiteName;
  if (!VALID_SUITES.includes(suiteRaw)) {
    throw new ScriptExitError(
      2,
      `Invalid --suite '${suiteRaw}' | valid: ${VALID_SUITES.join(', ')}`
    );
  }

  const tierRaw = readArgValue(argv, '--tier') ?? 'public';
  if (tierRaw !== 'public' && tierRaw !== 'confidential' && tierRaw !== 'personal') {
    throw new ScriptExitError(
      2,
      `Invalid --tier '${tierRaw}' | valid: public, confidential, personal`
    );
  }

  const repeats = parsePositiveIntFlag(argv, '--repeats') ?? 3;
  const minSamples = parsePositiveIntFlag(argv, '--min-samples');
  const minPerBin = parsePositiveIntFlag(argv, '--min-per-bin');
  const maxEce = parseMaxEceFlag(argv);
  const routingLedgerPath = readArgValue(argv, '--routing-ledger');
  const outputPath = readArgValue(argv, '--output');
  const casesPath = readArgValue(argv, '--cases');

  let customSpec: CalibrationSuiteSpec | undefined;
  if (casesPath) {
    const safePath = assertSafeRepositoryPath(pathResolver.rootResolve(casesPath));
    const raw = JSON.parse(String(safeReadFile(safePath, { encoding: 'utf8' })));
    const parsed = customCasesSchema.parse(raw);
    const questionObj: JudgmentQuestion = {
      kind: 'choice',
      id: parsed.question.id ?? parsed.questionId,
      options: parsed.question.options,
      ...(parsed.question.optionDescriptions
        ? { optionDescriptions: parsed.question.optionDescriptions }
        : {}),
      ...(parsed.question.instructions ? { instructions: parsed.question.instructions } : {}),
    };
    customSpec = {
      questionId: parsed.questionId,
      question: () => questionObj,
      cases: parsed.cases.map((row) => ({
        id: row.id,
        state: row.state,
        expected: row.expected as string | boolean | number,
      })),
    };
  }

  if (!options.preserveRegisteredBackends) {
    resetJudgmentBackends();
  }

  const result = await runJudgmentCalibration({
    provider,
    suite: suiteRaw,
    routingLedgerPath,
    customSpec,
    tier: tierRaw,
    tenantSlug: readArgValue(argv, '--tenant'),
    repeats,
    minSamples,
    minPerBin,
    maxEce,
    requireDeterministic: !argv.includes('--no-require-deterministic'),
    apply: argv.includes('--apply'),
    skipBootstrap: options.preserveRegisteredBackends,
    ...(options.calibrationFilePath ? { calibrationFilePath: options.calibrationFilePath } : {}),
  });

  const formatted = argv.includes('--json')
    ? JSON.stringify(result, null, 2)
    : formatSummaryText(result);

  if (outputPath) {
    const resolved = assertSafeRepositoryPath(pathResolver.rootResolve(outputPath), {
      allowMissingLeaf: true,
    });
    safeMkdir(path.dirname(resolved), { recursive: true });
    safeWriteFile(resolved, formatted + '\n');
  }
  print(formatted);
  return 0;
}

if (
  isDirectScript(import.meta.url, 'run_judgment_calibration.ts') ||
  isDirectScript(import.meta.url, 'run_judgment_calibration.js')
) {
  void defineScript({
    name: 'eval:judgment-calibration',
    flags: [],
    async run(context) {
      const status = await main(context.argv, context.print);
      if (status !== 0) {
        throw new ScriptExitError(status, `judgment calibration failed with status ${status}`);
      }
    },
  })();
}
