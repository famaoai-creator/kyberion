export interface SurfaceUxContractInput {
  text: string;
  approval_required?: boolean;
}

export interface SurfaceUxContractResult {
  valid: boolean;
  signals: Array<'request' | 'plan' | 'state' | 'result' | 'next_action'>;
  violations: string[];
}

const SIGNAL_PATTERNS: Array<{ signal: SurfaceUxContractResult['signals'][number]; patterns: RegExp[] }> = [
  { signal: 'request', patterns: [/\brequest\b/i, /理解した内容|依頼内容|要望|asked/i] },
  { signal: 'plan', patterns: [/\bplan\b/i, /実行計画|進め方|next steps?|手順/i] },
  { signal: 'state', patterns: [/\bstate\b/i, /状況|状態|running|waiting|blocked|completed|failed/i] },
  { signal: 'result', patterns: [/\bresult\b/i, /結果|deliverable|artifact|outcome/i] },
  { signal: 'next_action', patterns: [/\bnext action\b/i, /次のアクション|次にやること|unblock|承認してください/i] },
];

const INTERNAL_LEAKAGE_PATTERNS = [
  /\badf\b/i,
  /\bactuator\b/i,
  /\bruntime supervisor\b/i,
  /\bintent_resolution_packet\b/i,
  /\bexecution_shape\b/i,
];

const APPROVAL_CONSEQUENCE_PATTERNS = [
  /承認がない場合|承認されない場合|if not approved|without approval|blocked|停止/i,
];
const APPROVAL_ACTION_PATTERNS = [
  /承認してください|approve|unblock|next action|次のアクション/i,
];

function hasAnyPattern(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
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

  const signals = SIGNAL_PATTERNS
    .filter((entry) => hasAnyPattern(text, entry.patterns))
    .map((entry) => entry.signal);

  if (signals.length === 0) {
    violations.push('Response must include at least one user-facing signal (Request/Plan/State/Result/Next Action).');
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
