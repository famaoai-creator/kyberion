import { detectTextLocale, type SupportedLocale } from '../locale-normalize.js';
import { resolveLocale } from '../locale.js';
import { t, type VocabularyKey } from '../t.js';

export interface SurfaceUxContractInput {
  text: string;
  approval_required?: boolean;
  /** Allow natural replies for lightweight conversational turns such as greetings. */
  allow_conversational_reply?: boolean;
}

export interface SurfaceUxContractResult {
  valid: boolean;
  signals: Array<
    | 'request'
    | 'plan'
    | 'state'
    | 'result'
    | 'next_action'
    | 'bounded_task'
    | 'governed_mission'
    | 'review_context'
  >;
  violations: string[];
}

export interface SurfaceUxContractCheckOptions {
  approval_required?: boolean;
  allow_conversational_reply?: boolean;
}

export interface SurfaceUxContractCheckResult {
  text: string;
  verdict: SurfaceUxContractResult;
  repaired: boolean;
}

const SIGNAL_PATTERNS: Array<{
  signal: SurfaceUxContractResult['signals'][number];
  patterns: RegExp[];
}> = [
  { signal: 'request', patterns: [/\brequest\b/i, /理解した内容|依頼内容|要望|asked/i] },
  { signal: 'plan', patterns: [/\bplan\b/i, /実行計画|進め方|next steps?|手順/i] },
  {
    signal: 'state',
    patterns: [/\bstate\b/i, /状況|状態|running|waiting|blocked|completed|failed/i],
  },
  { signal: 'result', patterns: [/\bresult\b/i, /結果|deliverable|artifact|outcome/i] },
  {
    signal: 'next_action',
    patterns: [/\bnext action\b/i, /次のアクション|次にやること|unblock|承認してください/i],
  },
  {
    signal: 'bounded_task',
    patterns: [/短い作業として進めます|短い作業として進めて|短い作業|小さな作業|bounded task/i],
  },
  {
    signal: 'governed_mission',
    patterns: [
      /承認と記録が必要なためミッションとして進めます|ミッションとして進めます|governed mission/i,
    ],
  },
  {
    signal: 'review_context',
    patterns: [/レビュー目的|役割|テナント|persona|tenant|review purpose|レビュー対象/i],
  },
];

const INTERNAL_LEAKAGE_PATTERNS = [
  /\badf\b/i,
  /\bactuator\b/i,
  /\bruntime supervisor\b/i,
  /\bintent_resolution_packet\b/i,
  /\bexecution_shape\b/i,
  /\bmission_class\b/i,
  /\bworkflow_id\b/i,
];

const APPROVAL_CONSEQUENCE_PATTERNS = [
  /承認がない場合|承認されない場合|承認待ちです|まだ実行していません|if not approved|without approval|blocked|停止/i,
];
const APPROVAL_ACTION_PATTERNS = [/承認してください|approve|unblock|next action|次のアクション/i];

/**
 * Internal-vocabulary repair rules. The replacement wording lives in the
 * user-facing vocabulary catalog (`surface:ux_repair_*`), one entry per locale.
 */
const REPAIR_RULE_DEFS: Array<[RegExp, VocabularyKey]> = [
  [/\bADF\b/g, 'surface:ux_repair_adf'],
  [/\bactuator\b/gi, 'surface:ux_repair_actuator'],
  [/\bruntime supervisor\b/gi, 'surface:ux_repair_runtime_supervisor'],
  [/\bintent_resolution_packet\b/gi, 'surface:ux_repair_intent_resolution_packet'],
  [/\bexecution_shape\b/gi, 'surface:ux_repair_execution_shape'],
  [/\bmission_class\b/gi, 'surface:ux_repair_mission_class'],
  [/\bworkflow_id\b/gi, 'surface:ux_repair_workflow_id'],
  [/\bneeds_clarification\b/g, 'surface:ux_repair_needs_clarification'],
  [/\bfully_automatable\b/g, 'surface:ux_repair_fully_automatable'],
  [/\bneeds_external_assets\b/g, 'surface:ux_repair_needs_external_assets'],
  [/\bmissing_runtime_prerequisites\b/g, 'surface:ux_repair_missing_runtime_prerequisites'],
];

function buildRepairRules(locale: SupportedLocale): Array<[RegExp, string]> {
  return REPAIR_RULE_DEFS.map(([pattern, key]) => [pattern, t(key, undefined, locale)]);
}

function hasAnyPattern(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function replaceOutsideCodeFences(text: string, rules: Array<[RegExp, string]>): string {
  return text
    .split(/(```[\s\S]*?```)/g)
    .map((segment) => {
      if (segment.startsWith('```')) return segment;
      return rules.reduce(
        (current, [pattern, replacement]) => current.replace(pattern, replacement),
        segment
      );
    })
    .join('');
}

export function validateSurfaceUxContract(input: SurfaceUxContractInput): SurfaceUxContractResult {
  const text = String(input.text || '').trim();
  const violations: string[] = [];

  if (!text) {
    return {
      valid: false,
      signals: [],
      violations: ['Response text must not be empty.'],
    };
  }

  const signals = SIGNAL_PATTERNS.filter((entry) => hasAnyPattern(text, entry.patterns)).map(
    (entry) => entry.signal
  );

  if (signals.length === 0 && !input.allow_conversational_reply) {
    violations.push(
      'Response must include at least one user-facing signal (Request/Plan/State/Result/Next Action).'
    );
  }

  const leaked = INTERNAL_LEAKAGE_PATTERNS.filter((pattern) => pattern.test(text));
  if (leaked.length > 0) {
    violations.push('Response contains internal-only vocabulary in default user-facing output.');
  }

  if (input.approval_required) {
    if (!hasAnyPattern(text, APPROVAL_CONSEQUENCE_PATTERNS)) {
      violations.push('Approval-required response must explain consequence of waiting/rejection.');
    }
    if (!hasAnyPattern(text, APPROVAL_ACTION_PATTERNS)) {
      violations.push('Approval-required response must include a concrete unblock action.');
    }
  }

  return {
    valid: violations.length === 0,
    signals,
    violations,
  };
}

export function repairSurfaceUxContractText(input: string): string {
  const text = String(input || '');
  const rules = buildRepairRules(detectTextLocale(text) ?? resolveLocale());
  return replaceOutsideCodeFences(text, rules);
}

/**
 * Validate a user-facing reply and apply only deterministic, vocabulary-level
 * repairs when they make the reply pass the same contract. Callers that need
 * escalation can use the returned verdict to decide that separately; this
 * helper deliberately never re-asks a model or changes response semantics.
 */
export function checkAndRepairSurfaceUxContract(
  input: string,
  options: SurfaceUxContractCheckOptions = {}
): SurfaceUxContractCheckResult {
  const text = String(input || '');
  const verdict = validateSurfaceUxContract({ text, ...options });
  if (verdict.valid) return { text, verdict, repaired: false };

  const repairedText = repairSurfaceUxContractText(text);
  if (repairedText === text) return { text, verdict, repaired: false };

  const repairedVerdict = validateSurfaceUxContract({ text: repairedText, ...options });
  if (!repairedVerdict.valid) return { text, verdict, repaired: false };
  return { text: repairedText, verdict: repairedVerdict, repaired: true };
}
