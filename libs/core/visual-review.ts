import { z } from 'zod';
import { createLogger } from './logger.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import { validateReasoningEgress, type ContextSecurityScope } from './context-security-scope.js';
import { evaluateEgressPolicy } from './egress-policy.js';
import {
  isLocalReasoningBackend,
  reasoningBackendEndpoint,
  withReasoningPayloadScope,
} from './reasoning-egress-scope.js';
import { detectRasterCapabilities, rasterInstallHint } from './visual-raster.js';

/**
 * MP-04: look at the render, critique it, and say what to fix.
 *
 * The media path could produce an artifact but never inspect one, so quality
 * problems that are obvious to a human eye — text past a frame, everything
 * centered, a deck that reads as machine-made — shipped unnoticed. This module
 * owns the critique half of the loop: it takes rendered page images, asks the
 * reasoning backend to judge them against a data-defined rubric, and returns
 * structured findings the caller can act on.
 *
 * Two properties matter more than the critique itself:
 *
 * - **Egress is checked before anything leaves.** Rendered slides are the most
 *   sensitive artifact the system produces — a confidential deck rasterized to
 *   PNG is still confidential. A review of tenant material must not reach an
 *   external model just because a review was requested, so the security scope
 *   is consulted first and a denied review degrades instead of proceeding.
 * - **An unavailable review is not a passing review.** Missing rasterizers, a
 *   stub backend, or a denied egress all return `status: 'skipped'` with a
 *   reason. Callers must not read that as "no findings" (AR-06).
 */

const logger = createLogger('visual-review');

export type VisualFindingSeverity = 'error' | 'warning';
export type VisualFindingAction =
  | 'layout_fit'
  | 'content_reflow'
  | 'contrast_adjustment'
  | 'spacing_adjustment'
  | 'manual_review';

export interface VisualReviewCriterion {
  id: string;
  title: string;
  severity: VisualFindingSeverity;
  weight: number;
  prompt: string;
}

export interface VisualReviewRubric {
  version?: string;
  criteria: VisualReviewCriterion[];
  banned_patterns: string[];
  iteration: { max_rounds: number; stop_when_no_errors: boolean };
}

const BUILT_IN_RUBRIC: VisualReviewRubric = {
  criteria: [
    {
      id: 'overflow',
      title: 'Text fits its frame',
      severity: 'error',
      weight: 10,
      prompt: 'Does any text run past its box or collide with another element?',
    },
    {
      id: 'alignment',
      title: 'Alignment and margins',
      severity: 'error',
      weight: 9,
      prompt: 'Are elements aligned to a consistent grid with even margins?',
    },
  ],
  banned_patterns: [],
  iteration: { max_rounds: 3, stop_when_no_errors: true },
};

const cachedRubrics = new Map<string, VisualReviewRubric>();

export function loadVisualReviewRubric(options: { tenantSlug?: string } = {}): VisualReviewRubric {
  const tenantSlug =
    options.tenantSlug && /^[a-z][a-z0-9-]{1,30}$/u.test(options.tenantSlug)
      ? options.tenantSlug
      : '';
  const cacheKey = tenantSlug || 'public';
  const cached = cachedRubrics.get(cacheKey);
  if (cached) return cached;
  try {
    const candidatePaths = tenantSlug
      ? [
          pathResolver.knowledge(
            'confidential/' + tenantSlug + '/design/visual-review-rubric.json'
          ),
          pathResolver.knowledge(
            'public/design-patterns/media-templates/visual-review-rubric.json'
          ),
        ]
      : [
          pathResolver.knowledge(
            'public/design-patterns/media-templates/visual-review-rubric.json'
          ),
        ];
    const rubricPath = candidatePaths.find((candidate) => safeExistsSync(candidate));
    if (rubricPath) {
      const parsed = JSON.parse(safeReadFile(rubricPath, { encoding: 'utf8' }) as string);
      const criteria = Array.isArray(parsed?.criteria)
        ? parsed.criteria.filter((entry: any) => entry?.id && entry?.prompt)
        : [];
      if (criteria.length > 0) {
        const rubric = {
          version: String(parsed?.version || '1'),
          criteria,
          banned_patterns: Array.isArray(parsed.banned_patterns) ? parsed.banned_patterns : [],
          iteration: {
            max_rounds: Number(parsed?.iteration?.max_rounds) || 3,
            stop_when_no_errors: parsed?.iteration?.stop_when_no_errors !== false,
          },
        };
        cachedRubrics.set(cacheKey, rubric);
        return rubric;
      }
    }
  } catch (error: any) {
    logger.warn(`rubric unreadable, using built-in: ${error?.message || error}`);
  }
  cachedRubrics.set(cacheKey, BUILT_IN_RUBRIC);
  return BUILT_IN_RUBRIC;
}

export function resetVisualReviewRubricCache(): void {
  cachedRubrics.clear();
}

/** One actionable defect seen in the render. */
export const visualFindingSchema = z.object({
  criterion_id: z.string(),
  severity: z.enum(['error', 'warning']),
  /** 1-based page/slide/scene the finding is on; 0 when deck-wide. */
  page: z.number().int().min(0),
  summary: z.string().min(1),
  /** What to change, concretely enough to act on. */
  fix: z.string().min(1),
  recommended_action: z
    .enum([
      'layout_fit',
      'content_reflow',
      'contrast_adjustment',
      'spacing_adjustment',
      'manual_review',
    ])
    .optional(),
});

export const visualReviewResponseSchema = z.object({
  findings: z.array(visualFindingSchema).max(50),
  /** One-line verdict for the operator. */
  verdict: z.string().min(1),
});

export type VisualFinding = z.infer<typeof visualFindingSchema>;

function recommendedAction(criterionId: string): VisualFindingAction {
  const id = String(criterionId || '').toLowerCase();
  if (id.includes('overflow') || id.includes('fit')) return 'layout_fit';
  if (id.includes('contrast') || id.includes('color')) return 'contrast_adjustment';
  if (id.includes('spacing') || id.includes('margin')) return 'spacing_adjustment';
  if (id.includes('alignment')) return 'content_reflow';
  return 'manual_review';
}

export type VisualReviewStatus = 'reviewed' | 'skipped' | 'failed';

export interface VisualReviewReport {
  status: VisualReviewStatus;
  /** Present when the review ran. */
  findings: VisualFinding[];
  error_count: number;
  warning_count: number;
  verdict?: string;
  /** Why a review did not run. Never treat a skipped review as a pass. */
  skipped_reason?: string;
  images_reviewed: number;
  backend?: string;
}

export interface RunVisualReviewInput {
  /** Rendered page images, in page order. */
  images: string[];
  /** What is being reviewed, for the prompt. */
  artifactKind: 'pptx' | 'doc' | 'video-scenes' | 'web';
  title?: string;
  /**
   * Security scope of the material. Required: a review of tenant content is an
   * egress decision, not a rendering detail.
   */
  scope: ContextSecurityScope;
  /** Reasoning backend name, checked against the scope before any send. */
  backendName: string;
  /**
   * Vision-capable critique channel.
   *
   * Required, and deliberately not defaulted. The reasoning backend exposes
   * only text-shaped inputs today, so there is no path that can actually put
   * these images in front of a model. Falling back to a text delegation would
   * send file *paths* and get back confident findings about pixels nothing
   * ever looked at — a fabricated review, which is worse than no review. Until
   * a multimodal channel exists, callers must supply one or the review reports
   * itself as skipped.
   */
  critique?: (prompt: string, images: string[]) => Promise<unknown>;
  rubric?: VisualReviewRubric;
}

/** Backends that keep the material on this machine. */
const LOCAL_BACKENDS = /^(stub|local|ollama|mlx|apple-intelligence)$/u;

const TIER_ORDER = { public: 0, confidential: 1, personal: 2 } as const;

/** The most sensitive tier present decides how the payload must be treated. */
function mostSensitiveTier(tiers: readonly string[]): 'public' | 'confidential' | 'personal' {
  let worst: 'public' | 'confidential' | 'personal' = 'public';
  for (const tier of tiers) {
    if ((TIER_ORDER as any)[tier] > TIER_ORDER[worst]) {
      worst = tier as typeof worst;
    }
  }
  return worst;
}

function buildCritiquePrompt(input: RunVisualReviewInput, rubric: VisualReviewRubric): string {
  return [
    `You are reviewing a rendered ${input.artifactKind}${input.title ? ` titled "${input.title}"` : ''}.`,
    `${input.images.length} page image(s) are attached, in order, numbered from 1.`,
    '',
    'Judge each page against these criteria:',
    ...rubric.criteria.map(
      (criterion) => `- ${criterion.id} (${criterion.severity}): ${criterion.prompt}`
    ),
    '',
    rubric.banned_patterns.length > 0
      ? `Treat these as defects wherever they appear: ${rubric.banned_patterns.join(', ')}.`
      : '',
    '',
    'Report only what you can actually see in the images. Do not invent defects to',
    'seem thorough, and do not report a defect you cannot point to a page for.',
    'Every finding must carry a concrete fix, not a restatement of the problem.',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Run a visual review over rendered images.
 *
 * Returns `skipped` — never a clean pass — when the material may not leave the
 * host, when no images were produced, or when the backend cannot judge images.
 */
export async function runVisualReview(input: RunVisualReviewInput): Promise<VisualReviewReport> {
  const rubric = input.rubric ?? loadVisualReviewRubric();

  if (input.images.length === 0) {
    const capabilities = detectRasterCapabilities();
    return {
      status: 'skipped',
      findings: [],
      error_count: 0,
      warning_count: 0,
      images_reviewed: 0,
      skipped_reason:
        capabilities.missing.length > 0
          ? `no rendered images to review; this host is missing ${capabilities.missing.join(', ')} (install ${rasterInstallHint(capabilities.missing)})`
          : 'no rendered images to review',
    };
  }

  // Egress gate. A rasterized confidential deck is still confidential, so the
  // scope decides whether these pixels may reach this backend at all.
  const egress = validateReasoningEgress(input.scope, input.backendName);
  if (!egress.allowed) {
    logger.warn(`[visual-review] skipped: ${egress.reason}`);
    return {
      status: 'skipped',
      findings: [],
      error_count: 0,
      warning_count: 0,
      images_reviewed: 0,
      skipped_reason: `${egress.reason} — rendered pages were not sent for review`,
    };
  }

  // Second gate, for tenant material specifically.
  //
  // Reasoning backends reach their providers through their own SDK clients,
  // not through `secureFetch`, so the tier-aware egress policy would never see
  // this send. Consulting it here is what makes SA-04's tenant rule actually
  // govern a confidential deck being shipped to a model — the scope check above
  // only answers "may this backend be used at all", not "may this tenant's
  // material go to this provider".
  const payloadTier = mostSensitiveTier(input.scope.read_tiers);
  if (payloadTier !== 'public' && !isLocalReasoningBackend(input.backendName)) {
    const endpoint = reasoningBackendEndpoint(input.backendName);
    const decision = evaluateEgressPolicy(endpoint, {
      tier: payloadTier,
      tenant_slug: input.scope.tenant_id,
      purpose: 'media visual review',
    });
    if (decision.verdict === 'deny') {
      logger.warn(`[visual-review] skipped: ${decision.reason}`);
      return {
        status: 'skipped',
        findings: [],
        error_count: 0,
        warning_count: 0,
        images_reviewed: 0,
        skipped_reason: `${decision.reason} — rendered pages were not sent for review`,
      };
    }
  }
  if (input.critique && payloadTier !== 'public' && !isLocalReasoningBackend(input.backendName)) {
    return {
      status: 'skipped',
      findings: [],
      error_count: 0,
      warning_count: 0,
      images_reviewed: 0,
      skipped_reason:
        'caller-supplied critique is not an egress-governed transport for tenant material; use the backend vision channel',
    };
  }

  // A stub backend cannot judge pixels.
  if (!input.critique && LOCAL_BACKENDS.test(input.backendName) && input.backendName === 'stub') {
    return {
      status: 'skipped',
      findings: [],
      error_count: 0,
      warning_count: 0,
      images_reviewed: 0,
      skipped_reason:
        'reasoning backend is stub — visual critique needs a vision-capable backend; deterministic layout checks still applied',
    };
  }

  const prompt = buildCritiquePrompt(input, rubric);

  // Default channel: the backend's vision path. Deliberately never falls back
  // to a text delegation — that would ask a model to judge pages it was never
  // shown and get back confident findings about nothing.
  let critique = input.critique;
  if (!critique) {
    const { getReasoningBackend, backendSupportsVision } = await import('./reasoning-backend.js');
    const backend = getReasoningBackend();
    if (!backendSupportsVision(backend)) {
      return {
        status: 'skipped',
        findings: [],
        error_count: 0,
        warning_count: 0,
        images_reviewed: 0,
        skipped_reason: `reasoning backend "${input.backendName}" has no vision channel — the rendered pages were not inspected. Deterministic layout checks still applied.`,
      };
    }
    critique = async (text: string, images: string[]) => {
      const reply = await backend.promptWithImages!(
        `${text}\n\nReply with ONLY a JSON object: { "verdict": string, "findings": [{ "criterion_id": string, "severity": "error"|"warning", "page": number, "summary": string, "fix": string }] }`,
        images.map((imagePath) => ({ path: imagePath, media_type: 'image/png' as const }))
      );
      const jsonText = reply.slice(reply.indexOf('{'), reply.lastIndexOf('}') + 1);
      try {
        return JSON.parse(jsonText);
      } catch {
        const { tryRepairJson } = await import('./json-repair.js');
        return tryRepairJson(jsonText);
      }
    };
  }

  try {
    // Declaring the scope means the backend's own send gate applies too. Custom
    // external critique channels were rejected above because AsyncLocalStorage
    // cannot police arbitrary callback networking.
    const raw = await withReasoningPayloadScope(
      {
        tier: payloadTier,
        tenant_slug: input.scope.tenant_id,
        purpose: 'media visual review',
      },
      () => critique!(prompt, input.images)
    );
    const parsed = visualReviewResponseSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        status: 'failed',
        findings: [],
        error_count: 0,
        warning_count: 0,
        images_reviewed: input.images.length,
        skipped_reason: `critique did not match the expected shape: ${parsed.error.message}`,
      };
    }

    // Drop findings that point outside the pages actually reviewed — a model
    // citing page 9 of a 4-page deck is not describing this render.
    const findings = parsed.data.findings
      .filter((finding) => finding.page <= input.images.length)
      .map((finding) => ({
        ...finding,
        recommended_action: finding.recommended_action || recommendedAction(finding.criterion_id),
      }));
    const errorCount = findings.filter((finding) => finding.severity === 'error').length;

    return {
      status: 'reviewed',
      findings,
      error_count: errorCount,
      warning_count: findings.length - errorCount,
      verdict: parsed.data.verdict,
      images_reviewed: input.images.length,
      backend: input.backendName,
    };
  } catch (error: any) {
    return {
      status: 'failed',
      findings: [],
      error_count: 0,
      warning_count: 0,
      images_reviewed: input.images.length,
      skipped_reason: `visual critique failed: ${error?.message || error}`,
    };
  }
}

/** Render a report as operator-facing lines, errors first. */
export function formatVisualReviewReport(report: VisualReviewReport): string {
  if (report.status !== 'reviewed') {
    return `visual review ${report.status}: ${report.skipped_reason ?? 'no reason recorded'}`;
  }
  if (report.findings.length === 0) {
    return `visual review passed (${report.images_reviewed} page(s)): ${report.verdict ?? 'no findings'}`;
  }
  const lines = report.findings
    .slice()
    .sort((a, b) => (a.severity === b.severity ? a.page - b.page : a.severity === 'error' ? -1 : 1))
    .map(
      (finding) =>
        `[${finding.severity}] p${finding.page} ${finding.criterion_id}: ${finding.summary}\n    fix: ${finding.fix}`
    );
  return [
    `visual review: ${report.error_count} error(s), ${report.warning_count} warning(s)`,
    ...lines,
  ].join('\n');
}
