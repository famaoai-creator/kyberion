export interface SurfaceUxContractInput {
  text: string;
  approval_required?: boolean;
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
  /承認がない場合|承認されない場合|if not approved|without approval|blocked|停止/i,
];
const APPROVAL_ACTION_PATTERNS = [/承認してください|approve|unblock|next action|次のアクション/i];

const EN_REPAIR_RULES: Array<[RegExp, string]> = [
  [/\bADF\b/g, 'execution flow'],
  [/\bactuator\b/g, 'capability'],
  [/\bruntime supervisor\b/gi, 'control service'],
  [/\bintent_resolution_packet\b/gi, 'intent summary'],
  [/\bexecution_shape\b/gi, 'execution route'],
  [/\bmission_class\b/gi, 'mission type'],
  [/\bworkflow_id\b/gi, 'workflow ID'],
  [/\bneeds_clarification\b/g, 'needs clarification'],
  [/\bfully_automatable\b/g, 'ready to run'],
  [/\bneeds_external_assets\b/g, 'needs external assets'],
  [/\bmissing_runtime_prerequisites\b/g, 'missing runtime prerequisites'],
];

const JA_REPAIR_RULES: Array<[RegExp, string]> = [
  [/\bADF\b/g, '実行フロー'],
  [/\bactuator\b/gi, '機能'],
  [/\bruntime supervisor\b/gi, '制御サービス'],
  [/\bintent_resolution_packet\b/gi, '意図要約'],
  [/\bexecution_shape\b/gi, '実行形'],
  [/\bmission_class\b/gi, 'ミッション種別'],
  [/\bworkflow_id\b/gi, 'ワークフローID'],
  [/\bneeds_clarification\b/g, '追加確認が必要'],
  [/\bfully_automatable\b/g, 'そのまま実行可能'],
  [/\bneeds_external_assets\b/g, '外部素材が必要'],
  [/\bmissing_runtime_prerequisites\b/g, '実行環境が不足'],
];

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

  if (signals.length === 0) {
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
  const hasJapanese = /[ぁ-んァ-ン一-龯]/.test(text);
  const rules = hasJapanese ? JA_REPAIR_RULES : EN_REPAIR_RULES;
  return replaceOutsideCodeFences(text, rules);
}
