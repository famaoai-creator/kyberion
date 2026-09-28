/**
 * Typed shapes for media-actuator semantic briefs.
 *
 * Briefs are open JSON records authored by callers/LLM compilers — the
 * well-known optional fields are typed for ergonomic access while the
 * index signature preserves forward compatibility with new fields. These
 * replace the pervasive `brief: MediaBrief` annotations across the media pipeline.
 */

import type { MediaBriefCategory } from './media-document-helpers.js';

/** Table-of-contents / outline entry. Open record; `section_id`/`title` are conventional. */
export interface MediaTocEntry extends Record<string, unknown> {
  section_id?: string;
  title?: string;
  slideIndex?: number;
  slideId?: string;
}

/** Narrative outline produced by the `*_narrative_outline` builders. */
export interface MediaOutline extends Record<string, unknown> {
  toc?: MediaTocEntry[];
  recommended_theme?: unknown;
  design_system_id?: string;
  branding?: Record<string, unknown>;
  generation_boundary?: Record<string, unknown>;
}

/** Semantic brief: an open record with conventional optional fields. */
export interface MediaBrief extends Record<string, unknown> {
  kind?: string;
  category?: MediaBriefCategory | string;
  title?: string;
  objective?: string;
  locale?: string;
  audience?: string;
  story?: Record<string, unknown>;
  summary?: string;
  document_type?: string;
  document_profile?: Record<string, unknown>;
  render_target?: string;
  artifact_family?: string;
  layout_template_id?: string;
  design_system_id?: string;
  theme?: Record<string, unknown>;
  payload?: Record<string, unknown>;
  ctx?: Record<string, unknown>;
  source?: Record<string, unknown>;
  data?: Record<string, unknown>;
  options?: Record<string, unknown>;
  context?: Record<string, unknown>;
  evidence?: Record<string, unknown>[];
  issuer?: Record<string, unknown>;
  recipient?: Record<string, unknown>;
  client?: Record<string, unknown>;
  steps?: Record<string, unknown>[];
  chapters?: unknown[];
  slides?: Record<string, unknown>[];
  toc?: MediaTocEntry[];
  source_brief?: unknown;
}
