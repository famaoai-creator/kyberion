/**
 * TypeScript version of the template-renderer skill.
 *
 * Renders Mustache-style templates with provided data objects and
 * optionally writes the result to an output file.
 *
 * The CLI entry point remains in render.cjs; this module exports
 * typed helper functions for the core rendering logic.
 *
 * Usage:
 *   import { renderTemplate, buildRenderOutput } from './render.js';
 *   const result = renderTemplate(templateStr, data);
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SkillOutput } from '../../scripts/lib/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Data object passed to the template for variable substitution. */
export interface TemplateData {
  [key: string]: unknown;
}

/** Result of template rendering. */
export interface RenderResult {
  /** File path where the rendered output was written, if applicable. */
  output?: string;
  /** The rendered content string, if no output file was specified. */
  content?: string;
  /** Length of the rendered output in characters. */
  size: number;
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/**
 * Render a Mustache-style template string with the provided data.
 *
 * Performs simple '{{key}}' variable substitution matching the pattern
 * used in the CJS implementation. Nested keys and sections are not
 * supported in this lightweight implementation; use the CJS Mustache
 * library for full Mustache spec compliance.
 *
 * @param template - Template string with '{{variable}}' placeholders
 * @param data     - Data object providing values for placeholders
 * @returns Rendered string with placeholders replaced by data values
 */
export function renderTemplate(template: string, data: TemplateData): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    if (key in data) {
      return String(data[key]);
    }
    return match;
  });
}

// ---------------------------------------------------------------------------
// SkillOutput builder
// ---------------------------------------------------------------------------

/**
 * Build a SkillOutput envelope for the template-renderer skill.
 *
 * @param result  - Template rendering result data
 * @param startMs - Start timestamp from Date.now()
 * @returns Standard SkillOutput envelope
 */
export function buildRenderOutput(
  result: RenderResult,
  startMs: number
): SkillOutput<RenderResult> {
  return {
    skill: 'template-renderer',
    status: 'success',
    data: result,
    metadata: {
      duration_ms: Date.now() - startMs,
      timestamp: new Date().toISOString(),
    },
  };
}
