import { z } from 'zod';

/**
 * MP-05: lock the brief before anything is produced, and say which parts the
 * operator actually decided.
 *
 * Media work starts from an under-specified request ("make a deck about X"),
 * and the gap gets filled by inference — audience, tone, length, how many
 * review rounds. Those inferences are invisible in the output, so the first
 * time an operator learns the system guessed "executive audience" is when they
 * read a deck written for the wrong reader.
 *
 * A locked brief records each decision with its provenance. `stated` came from
 * the operator; `inferred` was chosen here and is the operator's to overturn.
 * Presenting the inferred set up front is what turns a silent assumption into
 * a reviewable one.
 */

export type DecisionProvenance = 'stated' | 'inferred' | 'default';

export const briefDecisionSchema = z.object({
  field: z.string().min(1),
  value: z.string().min(1),
  provenance: z.enum(['stated', 'inferred', 'default']),
  /** Why this value was chosen. Required for inferences — that is the point. */
  rationale: z.string().optional(),
});

export type BriefDecision = z.infer<typeof briefDecisionSchema>;

/**
 * How this run should be shaped. Deciding these once, up front, replaces the
 * per-run implicit judgement that made two runs of the same request behave
 * differently.
 */
/**
 * Pipeline context templating (`{{visual_review_rounds}}`) substitutes into
 * JSON as strings, so a run-shape arriving from a pipeline is all strings.
 * These coerce explicitly rather than using `z.coerce`, whose boolean rule
 * treats the string `"false"` as true — which would silently turn every
 * conservative default into a permission.
 */
const coercedInt = z.preprocess((value) => {
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : value;
  }
  return value;
}, z.number().int());

const coercedBoolean = z.preprocess((value) => {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return value;
}, z.boolean());

export const runShapeSchema = z.object({
  /** Pause for human review of the storyboard/outline before producing. */
  storyboard_review: coercedBoolean,
  /** Visual-review rounds; 0 disables the loop. */
  visual_review_rounds: coercedInt.pipe(z.number().min(0).max(10)),
  /** Whether a lower-fidelity fallback render may be delivered at all. */
  allow_degraded_fallback: coercedBoolean,
  /** Whether rendered pages may be sent to an external model for critique. */
  allow_external_visual_review: coercedBoolean,
});

export type RunShape = z.infer<typeof runShapeSchema>;

export const lockedMediaBriefSchema = z.object({
  kind: z.literal('locked-media-brief'),
  version: z.literal('1.0.0'),
  intent: z.string().min(1),
  decisions: z.array(briefDecisionSchema),
  run_shape: runShapeSchema,
  /** Immutable source payload used by downstream compilers after locking. */
  source_brief: z.record(z.string(), z.unknown()).optional(),
});

export type LockedMediaBrief = z.infer<typeof lockedMediaBriefSchema>;

/**
 * Conservative defaults.
 *
 * External visual review is off and degraded fallback is disallowed because
 * both are decisions with consequences the operator should opt into: one sends
 * their material outward, the other ships a lesser artifact.
 */
export const DEFAULT_RUN_SHAPE: RunShape = {
  storyboard_review: false,
  visual_review_rounds: 1,
  allow_degraded_fallback: false,
  allow_external_visual_review: false,
};

export interface LockMediaBriefInput {
  intent: string;
  /** Fields the operator stated explicitly, by field name. */
  stated: Record<string, string | undefined>;
  /** Fields chosen here, with the reason for each. */
  inferred?: Record<string, { value: string; rationale: string } | undefined>;
  runShape?: Partial<RunShape>;
  sourceBrief?: Record<string, unknown>;
}

export function lockMediaBrief(input: LockMediaBriefInput): LockedMediaBrief {
  const decisions: BriefDecision[] = [];

  for (const [field, value] of Object.entries(input.stated)) {
    if (value === undefined || String(value).trim() === '') continue;
    decisions.push({ field, value: String(value), provenance: 'stated' });
  }

  for (const [field, entry] of Object.entries(input.inferred ?? {})) {
    if (!entry || !entry.value) continue;
    // An inference the operator cannot see is the thing this exists to prevent,
    // so it is recorded with its reason or not at all.
    if (decisions.some((decision) => decision.field === field)) continue;
    decisions.push({
      field,
      value: entry.value,
      provenance: 'inferred',
      rationale: entry.rationale,
    });
  }

  const runShape: RunShape = { ...DEFAULT_RUN_SHAPE, ...(input.runShape ?? {}) };

  return lockedMediaBriefSchema.parse({
    kind: 'locked-media-brief',
    version: '1.0.0',
    intent: input.intent,
    decisions,
    run_shape: runShape,
    ...(input.sourceBrief ? { source_brief: input.sourceBrief } : {}),
  });
}

export function inferredDecisions(brief: LockedMediaBrief): BriefDecision[] {
  return brief.decisions.filter((decision) => decision.provenance !== 'stated');
}

/**
 * Render the brief for operator confirmation.
 *
 * Inferred decisions come first and are labelled as guesses, because the
 * operator only needs to act on the parts they did not choose.
 */
export function formatBriefForConfirmation(brief: LockedMediaBrief): string {
  const stated = brief.decisions.filter((decision) => decision.provenance === 'stated');
  const guessed = inferredDecisions(brief);
  const lines: string[] = [`Brief: ${brief.intent}`];

  if (guessed.length > 0) {
    lines.push('', 'Assumed (not stated — correct any of these):');
    for (const decision of guessed) {
      lines.push(
        `  - ${decision.field}: ${decision.value}${decision.rationale ? ` — ${decision.rationale}` : ''}`
      );
    }
  }

  if (stated.length > 0) {
    lines.push('', 'From your request:');
    for (const decision of stated) lines.push(`  - ${decision.field}: ${decision.value}`);
  }

  const shape = brief.run_shape;
  lines.push(
    '',
    'Run shape:',
    `  - storyboard review: ${shape.storyboard_review ? 'yes' : 'no'}`,
    `  - visual review rounds: ${shape.visual_review_rounds}`,
    `  - degraded fallback allowed: ${shape.allow_degraded_fallback ? 'yes' : 'no'}`,
    `  - external visual review: ${shape.allow_external_visual_review ? 'yes' : 'no'}`
  );

  return lines.join('\n');
}
