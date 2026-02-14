/**
 * TypeScript version of the data-transformer skill.
 *
 * Transforms data between JSON, YAML, and CSV formats.
 * The CLI entry point remains in transform.cjs; this module exports
 * typed helper functions for the core transformation logic.
 *
 * Usage:
 *   import { detectFormat, transformData } from './transform.js';
 *   const result = transformData(content, 'json', 'yaml');
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SkillOutput } from '../../scripts/lib/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Supported data formats for transformation. */
export type DataFormat = 'json' | 'yaml' | 'csv';

/** Result when output is written to a file. */
export interface TransformFileResult {
  output: string;
  format: DataFormat;
  size: number;
}

/** Result when output is returned inline. */
export interface TransformInlineResult {
  format: DataFormat;
  content: string;
}

/** Union of possible transform results. */
export type TransformResult = TransformFileResult | TransformInlineResult;

/** Options for the transformData function. */
export interface TransformOptions {
  /** Target output format. */
  to: DataFormat;
  /** Optional output file path. If omitted, content is returned inline. */
  outPath?: string;
}

// ---------------------------------------------------------------------------
// Format Detection
// ---------------------------------------------------------------------------

/**
 * Detect the data format of a file based on its extension.
 *
 * @param filePath - Path to the input file
 * @returns The detected format
 * @throws {Error} If the extension is not recognised
 */
export function detectFormat(filePath: string): DataFormat {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.json':
      return 'json';
    case '.yaml':
    case '.yml':
      return 'yaml';
    case '.csv':
      return 'csv';
    default:
      throw new Error(`Unknown input format "${ext}". Use .json, .yaml, or .csv`);
  }
}

// ---------------------------------------------------------------------------
// Serialisation helpers (minimal built-in implementations)
// ---------------------------------------------------------------------------

/**
 * Parse a data string according to its format.
 *
 * JSON is parsed natively. YAML and CSV parsing require the caller to supply
 * a pre-parsed value via the `parsedData` parameter because the canonical
 * parsers (js-yaml, papaparse) are CommonJS-only and lack type declarations.
 *
 * @param content    - Raw file content
 * @param format     - Format of the content
 * @param parsedData - Optional pre-parsed data (used for yaml/csv when the
 *                     caller has already parsed using a CJS library)
 * @returns Parsed data value
 */
export function parseContent(content: string, format: DataFormat, parsedData?: unknown): unknown {
  if (parsedData !== undefined) return parsedData;

  switch (format) {
    case 'json':
      return JSON.parse(content) as unknown;
    case 'yaml':
    case 'csv':
      throw new Error(`Format "${format}" requires a pre-parsed data value (parsedData argument)`);
    default:
      throw new Error(`Unsupported input format: ${format}`);
  }
}

/**
 * Serialize data to the target format string.
 *
 * JSON is serialised natively. YAML and CSV serialisation require the caller
 * to supply a serialiser callback because the canonical libraries are
 * CommonJS-only.
 *
 * @param data       - Data to serialise
 * @param format     - Target format
 * @param serialiser - Optional callback for yaml/csv serialisation
 * @returns Serialised string
 */
export function serializeData(
  data: unknown,
  format: DataFormat,
  serialiser?: (data: unknown) => string
): string {
  if (serialiser) return serialiser(data);

  switch (format) {
    case 'json':
      return JSON.stringify(data, null, 2);
    case 'yaml':
    case 'csv':
      throw new Error(`Format "${format}" requires an external serialiser callback`);
    default:
      throw new Error(`Unsupported output format: ${format}`);
  }
}

// ---------------------------------------------------------------------------
// Core transform
// ---------------------------------------------------------------------------

/**
 * Transform data from one format to another and optionally write to disk.
 *
 * @param data    - Already-parsed data to transform
 * @param options - Target format and optional output path
 * @param serialiser - Optional serialiser callback for yaml/csv output
 * @returns Transform result (file or inline)
 */
export function transformData(
  data: unknown,
  options: TransformOptions,
  serialiser?: (data: unknown) => string
): TransformResult {
  const output = serializeData(data, options.to, serialiser);

  if (options.outPath) {
    fs.writeFileSync(options.outPath, output);
    return { output: options.outPath, format: options.to, size: output.length };
  }

  return { format: options.to, content: output };
}

/**
 * Build a SkillOutput envelope for the data-transformer skill.
 *
 * @param result   - Transform result data
 * @param startMs  - Start timestamp from Date.now()
 * @returns Standard SkillOutput envelope
 */
export function buildTransformOutput(
  result: TransformResult,
  startMs: number
): SkillOutput<TransformResult> {
  return {
    skill: 'data-transformer',
    status: 'success',
    data: result,
    metadata: {
      duration_ms: Date.now() - startMs,
      timestamp: new Date().toISOString(),
    },
  };
}
