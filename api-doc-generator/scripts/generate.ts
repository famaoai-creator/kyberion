/**
 * TypeScript version of the api-doc-generator skill.
 *
 * Parses OpenAPI specification objects and generates Markdown documentation.
 *
 * The CLI entry point remains in generate.cjs; this module exports
 * typed helper functions for the core documentation generation logic.
 *
 * Usage:
 *   import { parseRoutes, generateDocMarkdown, buildApiDocOutput } from './generate.js';
 *   const endpoints = parseRoutes(openApiObj);
 *   const markdown = generateDocMarkdown(endpoints);
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SkillOutput } from '../../scripts/lib/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Describes a single API endpoint extracted from an OpenAPI spec. */
export interface ApiEndpoint {
  /** HTTP method (GET, POST, PUT, DELETE, etc.). */
  method: string;
  /** URL path for the endpoint. */
  path: string;
  /** Human-readable summary of the endpoint. */
  summary: string;
  /** Optional detailed description. */
  description?: string;
  /** Optional list of parameter names. */
  parameters?: string[];
}

/** Result of API documentation generation. */
export interface ApiDocResult {
  /** File path where the generated documentation was written, if applicable. */
  output?: string;
  /** Length of the generated Markdown content. */
  size: number;
  /** Number of endpoints documented. */
  endpointCount: number;
  /** The generated Markdown content. */
  content?: string;
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/**
 * Parse an OpenAPI specification object and extract API endpoints.
 *
 * Iterates over the `paths` section of the spec and collects each
 * method/path combination into an {@link ApiEndpoint} array.
 *
 * @param openApiObj - Parsed OpenAPI specification object
 * @returns Array of extracted API endpoints
 */
export function parseRoutes(openApiObj: Record<string, unknown>): ApiEndpoint[] {
  const endpoints: ApiEndpoint[] = [];
  const paths = (openApiObj.paths ?? {}) as Record<string, Record<string, unknown>>;

  for (const [routePath, methods] of Object.entries(paths)) {
    for (const [method, detail] of Object.entries(methods)) {
      if (typeof detail !== 'object' || detail === null) continue;
      const op = detail as Record<string, unknown>;
      const params = Array.isArray(op.parameters)
        ? (op.parameters as Array<Record<string, unknown>>).map((p) => String(p.name ?? ''))
        : undefined;

      endpoints.push({
        method: method.toUpperCase(),
        path: routePath,
        summary: String(op.summary ?? ''),
        description: op.description ? String(op.description) : undefined,
        parameters: params,
      });
    }
  }

  return endpoints;
}

/**
 * Generate Markdown documentation from a list of API endpoints.
 *
 * @param endpoints - Array of API endpoints to document
 * @returns Generated Markdown string
 */
export function generateDocMarkdown(endpoints: ApiEndpoint[]): string {
  let md = '# API Documentation\n\n';

  for (const ep of endpoints) {
    md += `## ${ep.method} ${ep.path}\n\n`;
    if (ep.summary) {
      md += `${ep.summary}\n\n`;
    }
    if (ep.description) {
      md += `${ep.description}\n\n`;
    }
    if (ep.parameters && ep.parameters.length > 0) {
      md += '**Parameters:**\n\n';
      for (const param of ep.parameters) {
        md += `- \`${param}\`\n`;
      }
      md += '\n';
    }
  }

  return md;
}

// ---------------------------------------------------------------------------
// SkillOutput builder
// ---------------------------------------------------------------------------

/**
 * Build a SkillOutput envelope for the api-doc-generator skill.
 *
 * @param result  - API documentation generation result data
 * @param startMs - Start timestamp from Date.now()
 * @returns Standard SkillOutput envelope
 */
export function buildApiDocOutput(
  result: ApiDocResult,
  startMs: number
): SkillOutput<ApiDocResult> {
  return {
    skill: 'api-doc-generator',
    status: 'success',
    data: result,
    metadata: {
      duration_ms: Date.now() - startMs,
      timestamp: new Date().toISOString(),
    },
  };
}
