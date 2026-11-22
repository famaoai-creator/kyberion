import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import { writeJson } from '@agent/core/foundation';
import { handleAction } from '../index.js';
import { validateReverseSpecEvidenceAt } from '@agent/core/mission';
import { extractCodeGraph, type CodeGraphRegistry } from './extract-code-graph.js';
import { loadCodeGraphEnumerationRules } from './enumeration-rules.js';

const ROOT = pathResolver.rootDir();
const FIXTURE_DIR = path.join(ROOT, 'libs/actuators/modeling-actuator/src/code-graph/__fixtures__');
const BASE = path.join(ROOT, 'active/shared/tmp', `code-graph-${randomUUID()}`);
const SOURCE = path.join(BASE, 'legacy');
const relativeSource = path.relative(ROOT, SOURCE).replaceAll(path.sep, '/');

/** Polyglot legacy source; kept as JSON so ESM/lint gates do not read fixture code as module code. */
const FILES = JSON.parse(
  String(safeReadFile(path.join(FIXTURE_DIR, 'polyglot-source.json'), { encoding: 'utf8' }))
) as Record<string, string>;

let graph: CodeGraphRegistry;

beforeAll(async () => {
  for (const [file, content] of Object.entries(FILES)) {
    safeMkdir(path.dirname(path.join(SOURCE, file)), { recursive: true });
    safeWriteFile(path.join(SOURCE, file), content);
  }
  graph = await extractCodeGraph({ sourceRoot: relativeSource });
}, 60000);

afterAll(() => {
  safeRmSync(BASE, { recursive: true, force: true });
});

const ids = () => graph.nodes.map((node) => node.id);
const edge = (from: string, to: string) =>
  graph.edges.some((entry) => entry.from === `MOD:${from}` && entry.to === `MOD:${to}`);

describe('modeling:extract_code_graph', () => {
  it('loads a rule for every supported language', () => {
    expect(
      loadCodeGraphEnumerationRules()
        .languages.map((rule) => rule.id)
        .sort()
    ).toEqual(
      [
        'c',
        'c_sharp',
        'cpp',
        'go',
        'java',
        'javascript',
        'php',
        'python',
        'ruby',
        'rust',
        'scala',
        'tsx',
        'typescript',
      ].sort()
    );
  });

  it('parses every language and records per-language stats', () => {
    for (const id of [
      'typescript',
      'tsx',
      'javascript',
      'python',
      'java',
      'c_sharp',
      'php',
      'rust',
      'go',
      'ruby',
      'c',
      'cpp',
      'scala',
    ]) {
      expect(graph.languages[id]?.parsed, id).toBeGreaterThan(0);
    }
    expect(graph.languages.typescript.parse_errors).toBe(1);
    expect(graph.unanalyzed_extensions).toEqual({ '.kt': 1 });
  });

  it('finds entrypoints and boundaries by both routes', () => {
    for (const id of [
      'EP:http_route:web/src/app.ts:4',
      'EP:http_route:web/legacy.js:2',
      'BND:http_client:web/src/billing.ts:2',
      'EP:http_route:py/app/views.py:3',
      'EP:main_guard:py/app/views.py:6',
      'BND:io_call:py/app/views.py:5',
      'EP:annotated_handler:java/src/main/java/com/acme/order/OrderController.java:6',
      'EP:main_method:java/src/main/java/com/acme/order/OrderController.java:8',
      'BND:persistence_or_client:java/src/main/java/com/acme/billing/Charge.java:2',
      'EP:attribute_route:cs/Orders.cs:3',
      'EP:attribute_route:cs/Orders.cs:5',
      'BND:io_client:cs/Orders.cs:6',
      'EP:framework_route:php/index.php:3',
      'BND:io_call:php/index.php:4',
      'EP:main_fn:rs/src/main.rs:4',
      'EP:main_fn:go/main.go:6',
      'EP:http_route:go/main.go:7',
      'EP:route_dsl:rb/config/routes.rb:2',
      'EP:route_dsl:rb/config/routes.rb:3',
      'BND:io_call:rb/app.rb:2',
      'EP:main_fn:c/main.c:3',
      'BND:io_call:c/main.c:4',
      'EP:main_fn:cpp/main.cpp:3',
      'EP:main_method:scala/src/main/scala/acme/Main.scala:4',
    ]) {
      const node = graph.nodes.find((entry) => entry.id === id);
      expect(node?.routes, id).toEqual(['a', 'b']);
    }
    // A method call on an unrelated object is not an HTTP route.
    expect(ids()).not.toContain('EP:http_route:web/src/app.ts:5');
  });

  it('resolves internal imports into edges and keeps third-party names external', () => {
    expect(edge('web/src/app.ts', 'web/src/billing.ts')).toBe(true);
    expect(edge('web/src/view.tsx', 'web/src/billing.ts')).toBe(true);
    expect(edge('web/src/esm.ts', 'web/src/billing.ts')).toBe(true);
    expect(edge('web/legacy.js', 'web/db.js')).toBe(true);
    expect(edge('py/app/views.py', 'py/app/models.py')).toBe(true);
    expect(
      edge(
        'java/src/main/java/com/acme/order/OrderController.java',
        'java/src/main/java/com/acme/billing/Charge.java'
      )
    ).toBe(true);
    expect(edge('cs/Orders.cs', 'cs/Billing.cs')).toBe(true);
    expect(edge('php/index.php', 'php/lib/db.php')).toBe(true);
    expect(edge('rs/src/main.rs', 'rs/src/billing.rs')).toBe(true);
    expect(edge('go/main.go', 'go/billing/billing.go')).toBe(true);
    expect(edge('rb/app.rb', 'rb/billing.rb')).toBe(true);
    expect(edge('c/main.c', 'c/billing.h')).toBe(true);
    expect(edge('cpp/main.cpp', 'cpp/billing.hpp')).toBe(true);
    expect(
      edge('scala/src/main/scala/acme/Main.scala', 'scala/src/main/scala/acme/billing/Charge.scala')
    ).toBe(true);
    expect(graph.external_dependencies).toEqual(
      expect.arrayContaining(['express', 'requests', 'fmt', 'std', 'java.util'])
    );
  });

  it('keeps the denominator as the union of both routes and reports the difference', () => {
    const modules = graph.reconciliation.find((row) => row.node_kind === 'module')!;
    expect(modules.only_in_b).toEqual(['web/src/broken.ts']);
    expect(modules.only_in_a).toEqual([]);
    expect(modules.route_b.count - modules.route_a.count).toBe(1);
    expect(ids()).toContain('MOD:web/src/broken.ts');
    expect(graph.nodes.find((node) => node.id === 'MOD:web/src/broken.ts')?.routes).toEqual(['b']);
  });

  it('produces a registry the reverse_spec code_graph gate accepts once differences are resolved', () => {
    const mission = path.join(BASE, 'mission');
    safeMkdir(path.join(mission, 'evidence'), { recursive: true });
    writeJson(path.join(mission, 'evidence/reverse-spec-scope.json'), {
      source_root: relativeSource,
      baseline_note: 'fixture without VCS',
      purpose: 'maintenance',
      in_scope: ['.'],
      exclusions: [],
      uncovered_extensions: [{ extension: '.kt', reason: 'no Kotlin grammar in the rules yet' }],
      references: [],
    });
    const write = (registry: CodeGraphRegistry) =>
      writeJson(path.join(mission, 'evidence/code-graph.json'), registry);
    write(graph);
    expect(() => validateReverseSpecEvidenceAt(mission, 'code_graph')).toThrow(
      /without a resolution/u
    );
    write({
      ...graph,
      reconciliation: graph.reconciliation.map((row) => ({
        ...row,
        resolution:
          row.only_in_a.length || row.only_in_b.length
            ? 'broken.ts has a syntax error; kept in the denominator'
            : '',
      })),
    });
    expect(validateReverseSpecEvidenceAt(mission, 'code_graph').ok).toBe(true);
  });

  it('runs as modeling:extract_code_graph and writes the registry through write_artifact', async () => {
    const output = path
      .join(path.relative(ROOT, BASE), 'out/code-graph.json')
      .replaceAll(path.sep, '/');
    await handleAction({
      action: 'pipeline',
      steps: [
        {
          type: 'transform',
          op: 'extract_code_graph',
          params: { source_root: relativeSource, languages: ['go'], export_as: 'code_graph' },
        },
        {
          type: 'apply',
          op: 'write_artifact',
          params: { from: 'code_graph', output_path: output },
        },
      ],
    });
    const written = JSON.parse(String(safeReadFile(path.join(ROOT, output), { encoding: 'utf8' })));
    expect(written.kind).toBe('code-graph-registry');
    expect(Object.keys(written.languages)).toEqual(['go']);
    expect(written.source_fingerprint.value).toBe(graph.source_fingerprint.value);
  });

  it('leaves excluded paths out of the graph but keeps them in the fingerprint', async () => {
    const narrowed = await extractCodeGraph({
      sourceRoot: relativeSource,
      exclude: ['web/', 'kt'],
    });
    expect(narrowed.excluded_paths).toEqual(['kt', 'web']);
    expect(narrowed.nodes.some((node) => node.path.startsWith('web/'))).toBe(false);
    expect(narrowed.unanalyzed_extensions).toEqual({});
    expect(narrowed.source_fingerprint).toEqual(graph.source_fingerprint);
  });

  it('reports files of filtered-out rule languages as unanalyzed', async () => {
    const goOnly = await extractCodeGraph({ sourceRoot: relativeSource, languages: ['go'] });
    expect(goOnly.generated_by.languages).toEqual(['go']);
    expect(Object.keys(goOnly.unanalyzed_extensions)).toEqual(
      expect.arrayContaining(['.ts', '.py', '.java', '.kt'])
    );
    expect(goOnly.unanalyzed_extensions).not.toHaveProperty('.go');
  });

  it('rejects unknown language filters', async () => {
    await expect(
      extractCodeGraph({ sourceRoot: relativeSource, languages: ['cobol'] })
    ).rejects.toThrow(/unknown language id\(s\): cobol/u);
  });
});
