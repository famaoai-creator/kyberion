/**
 * Product concept (SD-03): what a product is, for whom, what it promises,
 * and what it does not do. The greenfield hearing scenario (`web_app_build`,
 * seven requirements) is *already* this shape in disguise — mapping its
 * answers into a concept gives every later decision a root to point at
 * (`bound_to: ['PC-…']`) instead of a brief's free text.
 *
 * Pure. Unanswered requirements are omitted, never invented (same contract
 * as `applyHearingTurn`).
 */
import type { ActorRef } from '../actor.js';
import type { LedgerHearingAnswer } from './hearing-scenario.js';

export const PRODUCT_CONCEPT_ID_PATTERN = /^PC-[a-z0-9][a-z0-9-]{0,80}$/u;
/** How a free-text constraints answer is split into individual constraints (newline, `;`, `、`, `。`). */
export const CONSTRAINT_SEPARATOR_PATTERN = /[\n;、。]+/u;

export interface ProductConceptPromise {
  statement: string;
  /** How it is measured. A promise without a measure is a wish and is not recorded. */
  measured_by: string;
  status?: 'enacted' | 'proposed' | 'aspirational';
}

export interface ProductConceptNonGoal {
  statement: string;
  why: string;
  instead?: string;
}

export interface ProductConceptAxis {
  axis: string;
  kind: 'toggle' | 'value' | 'list' | 'label' | 'extend';
  options?: string[];
}

export interface ProductConcept {
  id: string;
  title: string;
  status: 'draft' | 'active' | 'superseded';
  problem?: string;
  for_whom: Array<{ actor: string; context: string; primary?: boolean }>;
  promises: ProductConceptPromise[];
  non_goals?: ProductConceptNonGoal[];
  constraints?: string[];
  core_flow?: string;
  content?: string;
  visual_direction?: string;
  variability_axes?: ProductConceptAxis[];
  source: { kind: 'hearing'; session_id: string; scenario: string };
  recorded_by: ActorRef;
  recorded_at: string;
}

/** Requirement ids of the built-in `web_app_build` hearing scenario. */
export const WEB_APP_CONCEPT_FIELDS = {
  audience: 'for_whom',
  problem: 'problem',
  core_flow: 'core_flow',
  content: 'content',
  visual_direction: 'visual_direction',
  constraints: 'constraints',
  success: 'promises',
} as const;

export function conceptIdForSession(sessionId: string): string {
  const slug = sessionId
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 80);
  const id = `PC-${slug || 'hearing'}`;
  if (!PRODUCT_CONCEPT_ID_PATTERN.test(id)) throw new Error('[DECISION_LEDGER_CONCEPT_ID_INVALID]');
  return id;
}

export interface HearingToConceptOptions {
  sessionId: string;
  scenario: string;
  recordedBy: ActorRef;
  now: string;
  title?: string;
  /** Override for splitting the constraints answer; defaults to {@link CONSTRAINT_SEPARATOR_PATTERN}. */
  constraintSeparator?: RegExp;
}

/**
 * Map answered `web_app_build` requirements to a concept. `success` becomes
 * the single promise with the answer as both statement and measure when the
 * answer does not separate them — the hearing asked "how will we know it
 * worked", which is a measure by construction.
 */
export function hearingAnswersToProductConcept(
  answers: readonly LedgerHearingAnswer[],
  options: HearingToConceptOptions
): ProductConcept {
  const byId = new Map(
    answers
      .filter((item) => typeof item.answer === 'string' && item.answer.trim())
      .map((item) => [item.id, (item.answer as string).trim()])
  );
  const audience = byId.get('audience');
  const success = byId.get('success');
  const constraints = byId.get('constraints');
  const concept: ProductConcept = {
    id: conceptIdForSession(options.sessionId),
    title: options.title || byId.get('problem') || options.sessionId,
    status: 'draft',
    for_whom: audience
      ? [{ actor: audience, context: byId.get('core_flow') || '', primary: true }]
      : [],
    promises: success ? [{ statement: success, measured_by: success, status: 'proposed' }] : [],
    source: { kind: 'hearing', session_id: options.sessionId, scenario: options.scenario },
    recorded_by: options.recordedBy,
    recorded_at: options.now,
  };
  const problem = byId.get('problem');
  if (problem) concept.problem = problem;
  const coreFlow = byId.get('core_flow');
  if (coreFlow) concept.core_flow = coreFlow;
  const content = byId.get('content');
  if (content) concept.content = content;
  const visual = byId.get('visual_direction');
  if (visual) concept.visual_direction = visual;
  if (constraints) {
    concept.constraints = constraints
      .split(options.constraintSeparator ?? CONSTRAINT_SEPARATOR_PATTERN)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return concept;
}

/** A concept is complete enough to become `active` when it names someone and promises something measurable. */
export function productConceptGaps(concept: ProductConcept): string[] {
  const gaps: string[] = [];
  if (concept.for_whom.length === 0) gaps.push('for_whom');
  if (concept.promises.length === 0) gaps.push('promises');
  if (!concept.problem) gaps.push('problem');
  return gaps;
}
