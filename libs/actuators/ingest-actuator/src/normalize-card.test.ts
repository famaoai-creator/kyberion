// DA-04 acceptance (2): generated frontmatter passes the knowledge-card
// contract, and missing required keys fail closed. Hermetic: tenant profile
// fixtures are seeded under active/shared/tmp (the governed temp location)
// through the resolveTenant path-options seam; no real knowledge/ file is
// touched and nothing is written by the op itself.
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import AjvModule from 'ajv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import { IngestCardIncompleteError, normalizeCard } from './normalize-card.js';
import type { IngestIr } from './parse-document.js';

const Ajv = (AjvModule as any).default ?? AjvModule;

function makeIr(overrides: Partial<IngestIr> = {}): IngestIr {
  return {
    title: 'Ingest Test Card',
    text_markdown: '# Ingest Test Card\n\nNormalized body.',
    meta: {
      source_system: 'confluence',
      source_id: 'PAGE-1',
      source_url: 'https://confluence.example.com/PAGE-1',
      source_version: '7',
      retrieved_at: '2026-07-20T00:00:00.000Z',
      format: 'markdown',
      content_sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      char_count: 34,
    },
    ...overrides,
  };
}

const NOW = '2026-07-28T09:00:00.000Z';

describe('ingest:normalize_card (DA-04 acceptance 2)', () => {
  it('derives kind/scope/authority from taxonomy directory_defaults for governed paths', () => {
    const result = normalizeCard({
      ir: makeIr(),
      target: { relative_path: 'knowledge/product/governance/ingest-test-card.md' },
      now: NOW,
    });
    expect(result.target_path).toBe('knowledge/product/governance/ingest-test-card.md');
    expect(result.frontmatter).toEqual({
      title: 'Ingest Test Card',
      tags: ['ingest', 'confluence'],
      importance: 5,
      last_updated: '2026-07-28',
      kind: 'governance',
      scope: 'global',
      authority: 'policy',
      source_system: 'confluence',
      source_id: 'PAGE-1',
      source_url: 'https://confluence.example.com/PAGE-1',
      source_version: '7',
      retrieved_at: '2026-07-20T00:00:00.000Z',
      content_sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
  });

  it('emits a deterministic card_markdown (frontmatter + body)', () => {
    const result = normalizeCard({
      ir: makeIr(),
      target: { relative_path: 'knowledge/product/governance/ingest-test-card.md' },
      now: NOW,
    });
    expect(result.body_markdown).toBe('# Ingest Test Card\n\nNormalized body.');
    expect(result.card_markdown).toBe(
      [
        '---',
        'title: Ingest Test Card',
        'tags: [ingest, confluence]',
        'importance: 5',
        'last_updated: 2026-07-28',
        'kind: governance',
        'scope: global',
        'authority: policy',
        'source_system: confluence',
        'source_id: PAGE-1',
        'source_url: https://confluence.example.com/PAGE-1',
        'source_version: 7',
        'retrieved_at: 2026-07-20T00:00:00.000Z',
        'content_sha256: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        '---',
        '',
        '# Ingest Test Card',
        '',
        'Normalized body.',
        '',
      ].join('\n')
    );
  });

  it('validates the generated frontmatter against the real knowledge-card schema', () => {
    const result = normalizeCard({
      ir: makeIr(),
      target: { relative_path: 'knowledge/product/governance/ingest-test-card.md' },
      now: NOW,
    });
    const schema = JSON.parse(
      safeReadFile(
        pathResolver.rootResolve('knowledge/product/schemas/knowledge-card.schema.json'),
        { encoding: 'utf8' }
      ) as string
    );
    const validate = new Ajv({ allErrors: true }).compile(schema);
    expect(validate(result.frontmatter), JSON.stringify(validate.errors)).toBe(true);
  });

  it('derives authority/scope from the taxonomy kind defaults when only kind is overridden', () => {
    const result = normalizeCard({
      ir: makeIr(),
      target: { relative_path: 'active/shared/tmp/ingest-preview/card.md' },
      card: { kind: 'reference' },
      now: NOW,
    });
    expect(result.frontmatter.kind).toBe('reference');
    expect(result.frontmatter.authority).toBe('reference');
    expect(result.frontmatter.scope).toBe('global');
  });

  it('fails closed with a structured error listing every missing key', () => {
    const ir = makeIr({ title: undefined });
    let caught: unknown;
    try {
      normalizeCard({ ir, target: { relative_path: 'somewhere/unclassified/doc.md' }, now: NOW });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(IngestCardIncompleteError);
    const structured = caught as IngestCardIncompleteError;
    expect(structured.missing_keys).toEqual(['title', 'kind', 'scope', 'authority']);
    expect(structured.message).toMatch(/INGEST_CARD_INCOMPLETE/);
    expect(structured.message).toMatch(/title, kind, scope, authority/);
  });

  it('fails closed when overrides break the knowledge-card schema (no partial card)', () => {
    expect(() =>
      normalizeCard({
        ir: makeIr(),
        target: { relative_path: 'knowledge/product/governance/ingest-test-card.md' },
        card: { importance: 0 },
        now: NOW,
      })
    ).toThrow(/INGEST_CARD_INCOMPLETE.*schema violations/);
  });

  it('rejects path traversal and absolute target paths', () => {
    expect(() =>
      normalizeCard({ ir: makeIr(), target: { relative_path: '../escape.md' }, now: NOW })
    ).toThrow(/must not contain '\.\.'/);
    expect(() =>
      normalizeCard({ ir: makeIr(), target: { relative_path: '/etc/passwd' }, now: NOW })
    ).toThrow(/must be relative/);
  });
});

describe('ingest:normalize_card tenant-aware target paths (DA-01 spine)', () => {
  const FIXTURE_PARENT = path.join(pathResolver.rootDir(), 'active', 'shared', 'tmp');
  const EMPTY_ENV = {} as NodeJS.ProcessEnv; // no KYBERION_CUSTOMER → personal tenants dir
  let fixtureRoot = '';

  beforeAll(() => {
    fixtureRoot = path.join(FIXTURE_PARENT, `ingest-normalize-da04-${randomUUID()}`);
    const tenantDir = path.join(fixtureRoot, 'knowledge', 'personal', 'tenants');
    safeMkdir(tenantDir, { recursive: true });
    safeWriteFile(
      path.join(tenantDir, 'acme-corp.json'),
      JSON.stringify(
        {
          tenant_slug: 'acme-corp',
          display_name: 'Acme Corp',
          status: 'active',
          assigned_role: 'owner',
        },
        null,
        2
      )
    );
  });

  afterAll(() => {
    if (fixtureRoot) safeRmSync(fixtureRoot, { recursive: true, force: true });
  });

  it('resolves the target path under the tenant knowledge_root via resolveTenant', () => {
    const result = normalizeCard({
      ir: makeIr(),
      target: { tenant_slug: 'acme-corp', relative_path: 'reports/q1.md' },
      card: { kind: 'reference' },
      now: NOW,
      path_options: { rootDir: fixtureRoot, env: EMPTY_ENV },
    });
    expect(result.target_path).toBe('knowledge/confidential/acme-corp/reports/q1.md');
    expect(result.frontmatter.kind).toBe('reference');
  });

  it('fails when the tenant has no registered profile', () => {
    expect(() =>
      normalizeCard({
        ir: makeIr(),
        target: { tenant_slug: 'ghost-co', relative_path: 'reports/q1.md' },
        card: { kind: 'reference' },
        now: NOW,
        path_options: { rootDir: fixtureRoot, env: EMPTY_ENV },
      })
    ).toThrow(/has no profile/);
  });
});
