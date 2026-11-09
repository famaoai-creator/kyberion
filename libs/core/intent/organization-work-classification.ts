/**
 * Organization-work classification, absorbed into the intent resolver (R3 of
 * the intent resolver unification plan, concept model v2 D7).
 *
 * This was an independent regex classifier inside the organization facade.
 * It now lives beside the resolver so the resolver entry
 * (`routing-decision.ts`) reads an utterance once and derives the
 * organization work shape from that same read. The rules and confidence
 * arithmetic are unchanged (resolver-adapter-characterization.test.ts).
 */
import type {
  OrganizationManagementUnit,
  OrganizationWorkShape,
} from '../organization/organization-operating-model.js';
import { isDocumentProjectRequest } from './intent-resolution.js';

export interface OrganizationWorkClassification {
  workShape: OrganizationWorkShape;
  managementUnit: Exclude<OrganizationManagementUnit, 'task_session'>;
  confidence: number;
  reasonKey: string;
  /** How `confidence` was reached; for audit and bench replay. */
  signals?: Record<string, unknown>;
}

/**
 * Terms that appear in a shape's vocabulary but are too generic to be
 * evidence *for* that shape on their own. '今月の運用レポートを作る' trips
 * three rules — routine on `レポート`, service on `運用`, solution on
 * `作る` — while meaning exactly one thing, and
 * '障害対応の月次レポートを作って承認をもらう' also trips three, while
 * genuinely being three work items. Rule count cannot tell those apart
 * (measured: both are 3), so competition is counted over rules that matched
 * on something specific instead.
 */
const GENERIC_RULE_TERMS = new Set([
  '作る', // i18n-exempt: classification vocabulary, not user-facing text
  '導入', // i18n-exempt: classification vocabulary, not user-facing text
  '新しい', // i18n-exempt: classification vocabulary, not user-facing text
  '運用', // i18n-exempt: classification vocabulary, not user-facing text
  'レビュー', // i18n-exempt: classification vocabulary, not user-facing text
  '改善', // i18n-exempt: classification vocabulary, not user-facing text
  'サービス', // i18n-exempt: classification vocabulary, not user-facing text
  'build',
  'make',
  'implement',
  'launch',
  'develop',
  'review',
  'improve',
  'optimize',
  'project',
]);

/**
 * Which alternatives of a rule's pattern are present. The six patterns are
 * flat literal alternations, so splitting the source is exact.
 */
function matchedTerms(pattern: RegExp, normalized: string): string[] {
  return pattern.source.split('|').filter((term) => term && normalized.includes(term));
}

/** A rule matched on at least one non-generic term. */
function isStrongMatch(pattern: RegExp, normalized: string): boolean {
  return matchedTerms(pattern, normalized).some((term) => !GENERIC_RULE_TERMS.has(term));
}

/**
 * Discount for an utterance that several shapes claim *specifically*. One
 * shape is unambiguous; three is a request that should reach a human rather
 * than be settled by rule order.
 */
function competitionFactor(strongMatchCount: number): number {
  if (strongMatchCount <= 1) return 1;
  if (strongMatchCount === 2) return 0.85;
  return 0.6;
}

/**
 * Does this utterance state an action at all?
 *
 * Detected by predicate morphology rather than a verb list: Japanese
 * predicates end in one of a small set of kana, and an enumerated list
 * misses ordinary forms (an early version scored '本番障害を収束させる' as
 * topic-only because `させる` was not in it).
 */
const WORK_PREDICATE_PATTERN =
  /[るうくすつぬぶむぐいたてろよ]$|ます$|たい$|ほしい|ください|お願い|[?？]$|\b(?:do|make|fix|check|please|want)\b/;

/**
 * Discount for an utterance that names a topic without stating work.
 * '請求まわり' matches the routine rule on 請求, but two nouns and no
 * predicate is not a request — it is the start of one, and the honest answer
 * is to ask. Length is a secondary signal for the same thing.
 */
function specificityFactor(utterance: string, normalized: string): number {
  const trimmed = utterance.trim();
  let factor = 1;
  if (!WORK_PREDICATE_PATTERN.test(trimmed) && !WORK_PREDICATE_PATTERN.test(normalized)) {
    factor *= 0.7;
  }
  if (trimmed.length < 8) factor *= 0.85;
  return factor;
}

export function classifyOrganizationWork(
  utterance: string,
  selectedTaskKind?: string
): OrganizationWorkClassification {
  const normalized = utterance.toLocaleLowerCase();
  const rules: Array<{
    workShape: OrganizationWorkShape;
    managementUnit: Exclude<OrganizationManagementUnit, 'task_session'>;
    confidence: number;
    pattern: RegExp;
    reasonKey: string;
  }> = [
    {
      workShape: 'incident_response',
      managementUnit: 'incident',
      confidence: 0.93,
      pattern: /障害|インシデント|緊急|停止|エラー|outage|incident|emergency|down/,
      reasonKey: 'organization:organization_resolution_reason_incident',
    },
    {
      workShape: 'governance_cadence',
      managementUnit: 'cadence',
      confidence: 0.9,
      pattern: /経営会議|レビュー|承認|決裁|監査|予算|方針|governance|review|approval|audit|budget/,
      reasonKey: 'organization:organization_resolution_reason_governance',
    },
    {
      workShape: 'routine_operation',
      managementUnit: 'operation',
      confidence: 0.88,
      pattern:
        /月次|週次|毎日|定期|定常|請求|レポート|監視|daily|weekly|monthly|routine|scheduled|report|monitor/,
      reasonKey: 'organization:organization_resolution_reason_routine',
    },
    {
      workShape: 'service_operation',
      managementUnit: 'service',
      confidence: 0.84,
      pattern: /サービス|窓口|運用|顧客対応|サポート|support|service|customer/,
      reasonKey: 'organization:organization_resolution_reason_service',
    },
    {
      workShape: 'improvement_experiment',
      managementUnit: 'experiment',
      confidence: 0.82,
      pattern: /改善|試す|実験|パイロット|pilot|experiment|optimize|improve/,
      reasonKey: 'organization:organization_resolution_reason_experiment',
    },
    {
      workShape: 'solution_project',
      managementUnit: 'project',
      confidence: 0.8,
      pattern: /作る|開発|構築|導入|新しい|project|build|develop|implement|launch/,
      reasonKey: 'organization:organization_resolution_reason_project',
    },
  ];
  // The rules remain first-match-wins except for explicit document projects;
  // only `confidence` is computed. Before this, every matched rule returned
  // its own hard-coded constant (0.80 … 0.93) and every fallback returned one
  // below the `< 0.7` human-confirmation threshold (0.40 / 0.58 / 0.62). The
  // two sets were disjoint, so the threshold was exactly "did any regex
  // match" and moved nowhere in (0.62, 0.80]; worse, keyword density is
  // anti-correlated with clarity here, so the most ambiguous utterances
  // scored highest — '請求まわり' (two nouns, no predicate) reached 0.88 and a
  // three-shape request reached 0.93, both sailing past the gate that exists
  // to catch them. Measured on mission JUDGMENT-SEAM-20260921,
  // `evidence/A1-baseline-confidence-audit.md` (findings F-1, F-2).
  //
  // Each rule's constant is kept as a *prior* — it encodes how reliable that
  // shape's vocabulary is — and is discounted by two signals that move in the
  // right direction:
  //   competition — how many other shapes also claim this utterance
  //   specificity — whether it states an action at all, rather than naming a topic
  const matchedRules = rules.filter((rule) => rule.pattern.test(normalized));
  // Review/calendar vocabulary can describe the deliverable rather than the
  // work being requested. Preserve incident priority and all confidence gates.
  const documentProject =
    matchedRules[0]?.workShape !== 'incident_response' && isDocumentProjectRequest(utterance);
  const matched = documentProject
    ? rules.find((rule) => rule.workShape === 'solution_project')
    : matchedRules[0];
  if (matched) {
    const strongMatches = matchedRules.filter((rule) => isStrongMatch(rule.pattern, normalized));
    const competition = competitionFactor(strongMatches.length);
    const specificity = specificityFactor(utterance, normalized);
    return {
      workShape: matched.workShape,
      managementUnit: matched.managementUnit,
      reasonKey: matched.reasonKey,
      confidence: Math.round(matched.confidence * competition * specificity * 100) / 100,
      signals: {
        prior: matched.confidence,
        ...(documentProject ? { semantic_precedence: 'document_project' } : {}),
        matched_shapes: matchedRules.map((rule) => rule.workShape),
        strong_shapes: strongMatches.map((rule) => rule.workShape),
        competition,
        specificity,
      },
    };
  }
  if (selectedTaskKind === 'project_bootstrap' || selectedTaskKind === 'mission') {
    return {
      workShape: 'solution_project',
      managementUnit: 'project',
      confidence: 0.62,
      reasonKey: 'organization:organization_resolution_reason_fallback_project',
    };
  }
  if (selectedTaskKind === 'task_session') {
    return {
      workShape: 'service_operation',
      managementUnit: 'service',
      confidence: 0.58,
      reasonKey: 'organization:organization_resolution_reason_fallback_service',
    };
  }
  return {
    workShape: 'routine_operation',
    managementUnit: 'operation',
    confidence: 0.4,
    reasonKey: 'organization:organization_resolution_reason_fallback_routine',
  };
}
