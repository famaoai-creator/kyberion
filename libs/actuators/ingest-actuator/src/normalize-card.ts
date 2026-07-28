/**
 * DA-04 ingest:normalize_card — ingest IR → knowledge-card candidate.
 *
 * Pure transform: derives the target path (tenant-aware via resolveTenant,
 * DA-01), auto-generates schema-compliant frontmatter (kind/scope/authority
 * from knowledge-taxonomy.json directory_defaults, provenance keys from the
 * IR meta) and returns { target_path, frontmatter, body_markdown,
 * card_markdown }. It NEVER writes into knowledge/ — the landing is DA-05's
 * ingest:commit.
 *
 * Fail-closed: when a required knowledge-card key cannot be derived, the op
 * throws IngestCardIncompleteError listing the missing keys — no partial
 * card is ever produced.
 */

import * as path from 'node:path';
import AjvModule from 'ajv';
import {
  compileSchemaFromPath,
  pathResolver,
  resolveTenant,
  safeReadFile,
  type TenantRegistryPathOptions,
} from '@agent/core';
import type { IngestIr } from './parse-document.js';

// Same CJS/ESM interop dance as tenant-registry.ts.
const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });

// Tracked source, resolved against the real repo root on purpose (same
// rationale as tenant-registry's schema resolution): fixtures still validate
// against the canonical contract.
const CARD_SCHEMA_PATH = pathResolver.rootResolve(
  'knowledge/product/schemas/knowledge-card.schema.json'
);
const TAXONOMY_PATH = pathResolver.rootResolve(
  'knowledge/product/governance/knowledge-taxonomy.json'
);

const cardValidate = compileSchemaFromPath(ajv, CARD_SCHEMA_PATH);

interface TaxonomyDirectoryDefault {
  path_prefix: string;
  kind?: string;
  authority?: string;
  scope?: string;
}

interface TaxonomyFile {
  kinds?: Record<string, { default_authority?: string; default_scope?: string }>;
  directory_defaults?: TaxonomyDirectoryDefault[];
}

let cachedTaxonomy: TaxonomyFile | null = null;

function loadTaxonomy(): TaxonomyFile {
  if (cachedTaxonomy) return cachedTaxonomy;
  cachedTaxonomy = JSON.parse(
    safeReadFile(TAXONOMY_PATH, { encoding: 'utf8' }) as string
  ) as TaxonomyFile;
  return cachedTaxonomy;
}

/** Longest matching directory_defaults entry for a repo-relative path. */
function directoryDefaultsFor(targetPath: string): TaxonomyDirectoryDefault | null {
  const defaults = loadTaxonomy().directory_defaults ?? [];
  let best: TaxonomyDirectoryDefault | null = null;
  for (const entry of defaults) {
    if (!targetPath.startsWith(entry.path_prefix)) continue;
    if (!best || entry.path_prefix.length > best.path_prefix.length) best = entry;
  }
  return best;
}

export class IngestCardIncompleteError extends Error {
  readonly missing_keys: string[];
  readonly schema_errors: string[];

  constructor(missingKeys: string[], schemaErrors: string[] = []) {
    const parts: string[] = [];
    if (missingKeys.length > 0) {
      parts.push(`missing required frontmatter keys: ${missingKeys.join(', ')}`);
    }
    if (schemaErrors.length > 0) {
      parts.push(`schema violations: ${schemaErrors.join('; ')}`);
    }
    super(`[INGEST_CARD_INCOMPLETE] ${parts.join(' — ')} (no partial card is produced)`);
    this.name = 'IngestCardIncompleteError';
    this.missing_keys = missingKeys;
    this.schema_errors = schemaErrors;
  }
}

export interface CardOverrides {
  title?: string;
  tags?: string[];
  importance?: number;
  last_updated?: string;
  kind?: string;
  scope?: string;
  authority?: string;
  [key: string]: unknown;
}

export interface NormalizeCardInput {
  ir: IngestIr;
  target: { tenant_slug?: string; relative_path: string };
  card?: CardOverrides;
  /**
   * Explicit timestamp for last_updated derivation (golden-test determinism).
   * Falls back to the IR's retrieved_at, then to the wall clock.
   */
  now?: string;
  /** Test seam: forwarded to resolveTenant (fixture roots). */
  path_options?: TenantRegistryPathOptions;
}

export interface NormalizeCardResult {
  target_path: string;
  frontmatter: Record<string, unknown>;
  body_markdown: string;
  card_markdown: string;
}

function assertSafeRelativePath(relativePath: string): void {
  if (path.isAbsolute(relativePath)) {
    throw new Error(
      `ingest:normalize_card — target.relative_path must be relative: ${relativePath}`
    );
  }
  const segments = relativePath.split(/[\\/]/);
  if (segments.some((segment) => segment === '..')) {
    throw new Error(
      `ingest:normalize_card — target.relative_path must not contain '..': ${relativePath}`
    );
  }
}

function resolveTargetPath(input: NormalizeCardInput): string {
  const relativePath = input.target?.relative_path;
  if (!relativePath || typeof relativePath !== 'string') {
    throw new Error('ingest:normalize_card — target.relative_path is required');
  }
  assertSafeRelativePath(relativePath);
  if (input.target.tenant_slug) {
    const resolved = resolveTenant(input.target.tenant_slug, input.path_options ?? {});
    return path.posix.join(resolved.knowledge_root, relativePath);
  }
  return relativePath.split(path.sep).join('/');
}

function dateOnly(timestamp: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(timestamp);
  return match ? match[1] : timestamp;
}

function yamlValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value
      .map((item) =>
        String(item)
          .replace(/[\r\n]+/g, ' ')
          .trim()
      )
      .join(', ')}]`;
  }
  return String(value)
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

function serializeFrontmatter(frontmatter: Record<string, unknown>): string {
  const lines = Object.entries(frontmatter)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}: ${yamlValue(value)}`);
  return `---\n${lines.join('\n')}\n---`;
}

export function normalizeCard(input: NormalizeCardInput): NormalizeCardResult {
  if (!input?.ir || typeof input.ir.text_markdown !== 'string' || !input.ir.meta) {
    throw new Error('ingest:normalize_card — ir with text_markdown and meta is required');
  }
  const targetPath = resolveTargetPath(input);
  const card = input.card ?? {};
  const defaults = directoryDefaultsFor(targetPath);
  const kinds = loadTaxonomy().kinds ?? {};

  const kind = card.kind ?? defaults?.kind;
  const kindDefaults = kind ? kinds[kind] : undefined;
  const authority = card.authority ?? defaults?.authority ?? kindDefaults?.default_authority;
  const scope = card.scope ?? defaults?.scope ?? kindDefaults?.default_scope;
  const title = card.title ?? input.ir.title;

  const missing: string[] = [];
  if (!title) missing.push('title');
  if (!kind) missing.push('kind');
  if (!scope) missing.push('scope');
  if (!authority) missing.push('authority');
  if (missing.length > 0) {
    throw new IngestCardIncompleteError(missing);
  }

  const meta = input.ir.meta;
  const timestamp = card.last_updated ?? input.now ?? meta.retrieved_at ?? new Date().toISOString();
  const {
    title: _title,
    tags: _tags,
    importance: _importance,
    last_updated: _lastUpdated,
    kind: _kind,
    scope: _scope,
    authority: _authority,
    ...extraOverrides
  } = card;

  const frontmatter: Record<string, unknown> = {
    title,
    tags: card.tags ?? (meta.source_system ? ['ingest', meta.source_system] : ['ingest']),
    importance: card.importance ?? 5,
    last_updated: dateOnly(String(timestamp)),
    kind,
    scope,
    authority,
    ...(meta.source_system !== undefined ? { source_system: meta.source_system } : {}),
    ...(meta.source_id !== undefined ? { source_id: meta.source_id } : {}),
    ...(meta.source_url !== undefined ? { source_url: meta.source_url } : {}),
    ...(meta.source_version !== undefined ? { source_version: meta.source_version } : {}),
    ...(meta.retrieved_at !== undefined ? { retrieved_at: meta.retrieved_at } : {}),
    content_sha256: meta.content_sha256,
    ...extraOverrides,
  };

  // Fail-closed contract gate: the generated frontmatter must pass the
  // knowledge-card schema before any card text is assembled.
  if (!cardValidate(frontmatter)) {
    const errors = (cardValidate.errors ?? []).map(
      (error) => `${error.instancePath || '/'} ${error.message ?? 'schema violation'}`
    );
    throw new IngestCardIncompleteError([], errors);
  }

  const bodyMarkdown = input.ir.text_markdown;
  const cardMarkdown = `${serializeFrontmatter(frontmatter)}\n\n${bodyMarkdown}\n`;
  return {
    target_path: targetPath,
    frontmatter,
    body_markdown: bodyMarkdown,
    card_markdown: cardMarkdown,
  };
}
