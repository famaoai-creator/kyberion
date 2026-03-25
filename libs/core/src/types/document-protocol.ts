/**
 * Document Design Protocol (ADF)
 * Generic base for all document format design protocols.
 * Implements a dual-layer model: semantic (editable) + raw (lossless preservation).
 *
 * Phase 3 of Engine Refinement Roadmap — Design Protocol Generalization.
 * This provides the unified generic base without breaking existing
 * PptxDesignProtocol or XlsxDesignProtocol contracts.
 */

import type { PptxDesignProtocol } from './pptx-protocol.js';
import type { XlsxDesignProtocol } from './xlsx-protocol.js';

// ─── Core Generic Types ─────────────────────────────────────

export interface TransformStep {
  operation: string;
  timestamp: string;
  details?: string;
}

export interface DocumentProvenance {
  sourceFile?: string;
  sourceFormat?: string;       // 'pptx' | 'xlsx' | 'docx' | 'pdf'
  extractedAt?: string;
  transformHistory: TransformStep[];
}

export interface DocumentDesignProtocol<T> {
  version: string;
  generatedAt: string;
  format: string;              // 'pptx' | 'xlsx' | 'docx' | 'pdf'
  provenance?: DocumentProvenance;

  // Semantic layer — structured, editable representation
  semantic: T;

  // Raw preservation layer — lossless ZIP entry passthrough
  rawParts?: { [entryName: string]: string };

  // Extensions — format-specific metadata
  extensions?: string;
}

// ─── Utility Types ──────────────────────────────────────────

/**
 * Utility type to extract the semantic type from a DocumentDesignProtocol
 */
export type SemanticOf<P> = P extends DocumentDesignProtocol<infer T> ? T : never;

// ─── Design Delta & Diff ────────────────────────────────────

/**
 * Design delta for diff detection
 */
export interface DesignDelta {
  path: string;           // e.g. "slides[2].elements[0].text"
  type: 'added' | 'removed' | 'changed';
  oldValue?: any;
  newValue?: any;
}

/**
 * Compute semantic differences between two protocols of the same type.
 * Only compares the semantic layer; raw preservation fields are skipped.
 */
export function diffDesign<T>(a: DocumentDesignProtocol<T>, b: DocumentDesignProtocol<T>): DesignDelta[] {
  // Shallow diff of the semantic layer
  return diffObjects(a.semantic, b.semantic, '');
}

// Internal recursive diff helper
function diffObjects(a: any, b: any, basePath: string): DesignDelta[] {
  const deltas: DesignDelta[] = [];
  if (a === b) return deltas;
  if (a === null || a === undefined || b === null || b === undefined) {
    if (a !== b) deltas.push({ path: basePath || 'root', type: 'changed', oldValue: a, newValue: b });
    return deltas;
  }
  if (typeof a !== typeof b) {
    deltas.push({ path: basePath || 'root', type: 'changed', oldValue: a, newValue: b });
    return deltas;
  }
  if (typeof a !== 'object') {
    if (a !== b) deltas.push({ path: basePath || 'root', type: 'changed', oldValue: a, newValue: b });
    return deltas;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const maxLen = Math.max(a.length, b.length);
    for (let i = 0; i < maxLen; i++) {
      const p = basePath ? `${basePath}[${i}]` : `[${i}]`;
      if (i >= a.length) { deltas.push({ path: p, type: 'added', newValue: b[i] }); }
      else if (i >= b.length) { deltas.push({ path: p, type: 'removed', oldValue: a[i] }); }
      else { deltas.push(...diffObjects(a[i], b[i], p)); }
    }
    return deltas;
  }
  const allKeys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of allKeys) {
    // Skip rawXml and other raw preservation fields for semantic diff
    if (key.startsWith('raw') || key === '_refDepth' || key === '_knowledgeIndex') continue;
    const p = basePath ? `${basePath}.${key}` : key;
    if (!(key in a)) { deltas.push({ path: p, type: 'added', newValue: b[key] }); }
    else if (!(key in b)) { deltas.push({ path: p, type: 'removed', oldValue: a[key] }); }
    else { deltas.push(...diffObjects(a[key], b[key], p)); }
  }
  return deltas;
}

// ─── Bridge Wrappers ────────────────────────────────────────
// These wrap existing format-specific protocols as DocumentDesignProtocol
// without requiring migration. This is a non-breaking bridge for Phase 3.

/**
 * Wrap an existing PptxDesignProtocol as a DocumentDesignProtocol for use with diffDesign().
 *
 * Relationship: PptxDesignProtocol ≈ DocumentDesignProtocol<PptxSemantic>
 * where PptxSemantic = Omit<PptxDesignProtocol, 'version' | 'generatedAt' | 'rawParts' | 'extensions'>
 *
 * Full refactor to extend DocumentDesignProtocol is planned for Phase 3.2.
 */
export function wrapAsPptxDocument(protocol: PptxDesignProtocol): DocumentDesignProtocol<Omit<PptxDesignProtocol, 'version' | 'generatedAt' | 'rawParts' | 'extensions'>> {
  const { version, generatedAt, rawParts, extensions, ...semantic } = protocol;
  return { version, generatedAt, format: 'pptx', semantic, rawParts, extensions };
}

/**
 * Wrap an existing XlsxDesignProtocol as a DocumentDesignProtocol for use with diffDesign().
 *
 * Relationship: XlsxDesignProtocol ≈ DocumentDesignProtocol<XlsxSemantic>
 * where XlsxSemantic = Omit<XlsxDesignProtocol, 'version' | 'generatedAt' | 'rawParts' | 'extensions'>
 *
 * Full refactor to extend DocumentDesignProtocol is planned for Phase 3.3.
 */
export function wrapAsXlsxDocument(protocol: XlsxDesignProtocol): DocumentDesignProtocol<Omit<XlsxDesignProtocol, 'version' | 'generatedAt' | 'rawParts' | 'extensions'>> {
  const { version, generatedAt, rawParts, extensions, ...semantic } = protocol;
  return { version, generatedAt, format: 'xlsx', semantic, rawParts, extensions };
}
