/**
 * Concept registry gate: one registered definition, canonical document, glossary entry and
 * owner per high-confusion term, plus the document retirement lifecycle (`doc_status`).
 *
 * The validators are pure over a {@link RepoView} so tests can drive every failure mode
 * without touching the checkout. Workflow: knowledge/product/governance/concept-registry-workflow.md.
 */
import * as path from 'node:path';
import { withExecutionContext } from '@agent/core/authority';
import { readTextFile, writeJson } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeLstat, safeReaddir } from '@agent/core/secure-io';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';
import { resolveCiGateBaselinePath } from './lib/ci-gate-baseline.js';
import { parseFrontmatter } from './check_improvement_plan_metadata.js';

export const CONCEPT_REGISTRY = 'knowledge/product/governance/concept-registry.json';
export const GLOSSARY = 'docs/GLOSSARY.md';
export const DOCUMENTATION_SOURCE_MAP = 'docs/documentation-source-map.json';
export const ARCHITECTURE_ROOT = 'knowledge/product/architecture';
export const PLAN_ROOT = 'docs/developer';
export const GATE_ID = 'concept-registry';

/** Retirement states. Absence means the document is current; canonical-ness lives only in the
 * source map and the registry, never in a document's own frontmatter. */
export const DOC_STATUSES = ['superseded', 'historical'] as const;

export interface ConceptSense {
  qualifier: string;
  glossary_anchor: string;
  definition: string;
}

export interface ConceptTerm {
  id: string;
  term: string;
  aliases?: string[];
  category: string;
  definition: string;
  glossary_anchor: string;
  canonical_doc: string;
  owner_modules?: string[];
  not_to_confuse_with?: string[];
  senses?: ConceptSense[];
  lifecycle?: ConceptLifecycle;
}

/** Lifecycle states a registry term may be in. Absence means current: code and docs agree. */
export const CONCEPT_LIFECYCLE_STATES = ['transitioning', 'deprecated'] as const;

/**
 * A decided change of meaning. `transitioning`: the definition is the decided target and
 * code is migrating under `plan`. `deprecated`: the term is being removed in favour of
 * `replaced_by`. Both cite the decision record that made the call.
 */
export interface ConceptLifecycle {
  state: (typeof CONCEPT_LIFECYCLE_STATES)[number];
  decision: string;
  plan?: string;
  replaced_by?: string[];
}

export interface ConceptRegistry {
  manifest_version: number;
  terms: ConceptTerm[];
}

export interface ConceptRegistryBaseline {
  $schema?: string;
  version: 1;
  /** Architecture docs that predate the `concepts:` frontmatter rule. Shrink-only. */
  architecture_docs_without_concepts: string[];
}

/** Read-only view of the repository, relative to the checkout root. */
export interface RepoView {
  exists(relativePath: string): boolean;
  isDirectory(relativePath: string): boolean;
  read(relativePath: string): string;
  list(relativeDir: string): string[];
}

// ---------------------------------------------------------------------------
// Markdown helpers
// ---------------------------------------------------------------------------

/** GitHub-compatible heading slug (lowercase, punctuation stripped, spaces → hyphens). */
export function headingSlug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/`/gu, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/gu, '-');
}

export interface MarkdownHeading {
  level: number;
  text: string;
  slug: string;
  line: number;
}

export function collectHeadings(markdown: string): MarkdownHeading[] {
  const headings: MarkdownHeading[] = [];
  let fence: string | null = null;
  markdown.split(/\r?\n/u).forEach((line, index) => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/u)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      return;
    }
    if (fence) return;
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line);
    if (match) {
      headings.push({
        level: match[1].length,
        text: match[2],
        slug: headingSlug(match[2]),
        line: index + 1,
      });
    }
  });
  return headings;
}

/** "Channel (delivery route)" → { base: "channel", qualifier: "delivery route" }. */
export function splitQualifiedHeading(text: string): { base: string; qualifier?: string } {
  const match = /^(.*?)\s*\(([^)]*)\)\s*$/u.exec(text);
  if (!match || !match[1].trim()) return { base: text.trim().toLowerCase() };
  return { base: match[1].trim().toLowerCase(), qualifier: match[2].trim().toLowerCase() };
}

export function collectLinkTargets(markdown: string): string[] {
  return [...markdown.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu)].map((match) => match[1]);
}

/** Rows of the GLOSSARY "Contributor vocabulary" table: term → definition cell. */
export function collectContributorVocabulary(markdown: string): Map<string, string> {
  const rows = new Map<string, string>();
  const lines = markdown.split(/\r?\n/u);
  const start = lines.findIndex((line) => /^###\s+Contributor vocabulary\s*$/u.test(line));
  if (start < 0) return rows;
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/u.test(line)) break;
    const cells = line.split('|').map((cell) => cell.trim());
    if (cells.length < 4 || /^-+$/u.test(cells[1]) || cells[1] === 'Term') continue;
    rows.set(cells[1].toLowerCase(), cells[2]);
  }
  return rows;
}

function stripAnchor(reference: string): { file: string; anchor?: string } {
  const index = reference.indexOf('#');
  return index < 0
    ? { file: reference }
    : { file: reference.slice(0, index), anchor: reference.slice(index + 1) };
}

function parseInlineList(value: string | undefined): string[] | null {
  if (value === undefined) return null;
  const match = /^\[(.*)\]$/u.exec(value.trim());
  if (!match) return null;
  return match[1]
    .split(',')
    .map((item) => item.trim().replace(/^['"]|['"]$/gu, ''))
    .filter(Boolean);
}

function frontmatterOf(view: RepoView, relativePath: string): Record<string, string> | null {
  if (!relativePath.endsWith('.md') || !view.exists(relativePath)) return null;
  const markdown = view.read(relativePath);
  const fields = parseFrontmatter(markdown);
  if (fields?.concepts === '') {
    const folded = foldMultilineList(markdown, 'concepts');
    if (folded !== undefined) fields.concepts = folded;
  }
  return fields;
}

/**
 * Prettier wraps a long flow list (`key: [a, b, …]`) onto several lines, and authors may
 * write a block list (`- a`). Both are folded back to the inline form `[a, b]`; any other
 * multi-line value is left empty so the caller reports it.
 */
export function foldMultilineList(markdown: string, key: string): string | undefined {
  const lines = markdown.replace(/\r\n/gu, '\n').split('\n');
  const end = lines.indexOf('---', 1);
  if (lines[0] !== '---' || end < 0) return undefined;
  const start = lines.findIndex(
    (line, index) => index < end && line.replace(/\s+$/u, '') === `${key}:`
  );
  if (start < 0) return undefined;
  const body: string[] = [];
  for (const line of lines.slice(start + 1, end)) {
    // Indented continuation, or an unindented block-list item (`- a`, valid YAML).
    if (!/^\s/u.test(line) && !line.startsWith('- ')) break;
    body.push(line.trim());
  }
  const flow = body.join(' ');
  if (/^\[.*\]$/u.test(flow)) return flow;
  if (body.length > 0 && body.every((line) => line.startsWith('- '))) {
    return `[${body.map((line) => line.slice(2).trim()).join(', ')}]`;
  }
  return undefined;
}

function retiredStatus(view: RepoView, relativePath: string): string | undefined {
  const status = frontmatterOf(view, relativePath)?.doc_status;
  return status && (DOC_STATUSES as readonly string[]).includes(status) ? status : undefined;
}

// ---------------------------------------------------------------------------
// C1 — registry integrity
// ---------------------------------------------------------------------------

export function validateRegistry(registry: ConceptRegistry, view: RepoView): string[] {
  const failures: string[] = [];
  if (registry.manifest_version !== 1) failures.push('registry: manifest_version must be 1');
  if (!Array.isArray(registry.terms) || registry.terms.length === 0) {
    return [...failures, 'registry: terms must be a non-empty array'];
  }
  const ids = new Set<string>();
  const names = new Map<string, string>();
  for (const entry of registry.terms) {
    if (ids.has(entry.id)) failures.push(`registry: duplicate id ${entry.id}`);
    ids.add(entry.id);
    for (const name of [entry.term, ...(entry.aliases ?? [])]) {
      const key = name.trim().toLowerCase();
      const owner = names.get(key);
      if (owner && owner !== entry.id) {
        failures.push(
          `registry: "${name}" is claimed by both ${owner} and ${entry.id} — one term, one entry`
        );
      } else if (owner === entry.id) {
        failures.push(`registry: ${entry.id} lists "${name}" twice`);
      }
      names.set(key, entry.id);
    }
    if (!entry.definition?.trim()) failures.push(`registry: ${entry.id} needs a definition`);
    const { file } = stripAnchor(entry.canonical_doc ?? '');
    if (!file || !view.exists(file)) {
      failures.push(`registry: ${entry.id} canonical_doc does not exist: ${entry.canonical_doc}`);
    }
    for (const module of entry.owner_modules ?? []) {
      if (!view.exists(module)) {
        failures.push(`registry: ${entry.id} owner module does not exist: ${module}`);
      }
    }
    if (entry.senses) {
      const qualifiers = new Set<string>();
      for (const sense of entry.senses) {
        const key = sense.qualifier.trim().toLowerCase();
        if (qualifiers.has(key)) failures.push(`registry: ${entry.id} repeats sense ${key}`);
        qualifiers.add(key);
      }
    }
  }
  const deprecated = new Set(
    registry.terms
      .filter((entry) => entry.lifecycle?.state === 'deprecated')
      .map((entry) => entry.id)
  );
  for (const entry of registry.terms) {
    for (const other of entry.not_to_confuse_with ?? []) {
      if (!ids.has(other)) {
        failures.push(`registry: ${entry.id} not_to_confuse_with unknown id ${other}`);
      }
    }
    failures.push(...checkLifecycle(entry, ids, deprecated, view));
  }
  return failures;
}

function checkLifecycle(
  entry: ConceptTerm,
  ids: ReadonlySet<string>,
  deprecated: ReadonlySet<string>,
  view: RepoView
): string[] {
  const lifecycle = entry.lifecycle;
  if (!lifecycle) return [];
  const failures: string[] = [];
  if (!(CONCEPT_LIFECYCLE_STATES as readonly string[]).includes(lifecycle.state)) {
    failures.push(
      `registry: ${entry.id} lifecycle.state must be one of ${CONCEPT_LIFECYCLE_STATES.join('|')}`
    );
  }
  if (!lifecycle.decision) failures.push(`registry: ${entry.id} lifecycle needs a decision record`);
  for (const [field, target] of [
    ['decision', lifecycle.decision],
    ['plan', lifecycle.plan],
  ] as const) {
    if (!target) continue;
    const { file, anchor } = stripAnchor(target);
    if (!file || !view.exists(file)) {
      failures.push(`registry: ${entry.id} lifecycle.${field} does not exist: ${target}`);
    } else if (
      anchor &&
      file.endsWith('.md') &&
      !collectHeadings(view.read(file)).some((heading) => heading.slug === anchor)
    ) {
      failures.push(
        `registry: ${entry.id} lifecycle.${field} has no heading #${anchor}: ${target}`
      );
    }
  }
  if (lifecycle.state === 'transitioning' && !lifecycle.plan) {
    failures.push(`registry: ${entry.id} is transitioning — name the migration plan`);
  }
  if (lifecycle.state === 'deprecated') {
    const replacements = lifecycle.replaced_by ?? [];
    if (replacements.length === 0) {
      failures.push(`registry: ${entry.id} is deprecated — name replaced_by`);
    }
    for (const replacement of replacements) {
      if (!ids.has(replacement)) {
        failures.push(`registry: ${entry.id} replaced_by unknown id ${replacement}`);
      } else if (deprecated.has(replacement)) {
        failures.push(
          `registry: ${entry.id} replaced_by ${replacement}, which is itself deprecated`
        );
      }
    }
  } else if (lifecycle.replaced_by?.length) {
    failures.push(`registry: ${entry.id} lists replaced_by but is not deprecated`);
  }
  return failures;
}

// ---------------------------------------------------------------------------
// C2/C3 — glossary agreement
// ---------------------------------------------------------------------------

export function checkGlossary(registry: ConceptRegistry, glossary: string): string[] {
  const failures: string[] = [];
  const headings = collectHeadings(glossary);
  const slugs = new Set(headings.map((heading) => heading.slug));

  for (const entry of registry.terms) {
    if (!slugs.has(entry.glossary_anchor)) {
      failures.push(`${GLOSSARY}: no heading for ${entry.id} (#${entry.glossary_anchor})`);
    }
    for (const sense of entry.senses ?? []) {
      if (!slugs.has(sense.glossary_anchor)) {
        failures.push(
          `${GLOSSARY}: no heading for ${entry.id} sense "${sense.qualifier}" (#${sense.glossary_anchor})`
        );
      }
    }
    const { file, anchor } = stripAnchor(entry.canonical_doc);
    if (file === GLOSSARY && anchor && !slugs.has(anchor)) {
      failures.push(
        `registry: ${entry.id} canonical_doc anchor #${anchor} is not a GLOSSARY heading`
      );
    }
  }

  const byBase = new Map<string, MarkdownHeading[]>();
  for (const heading of headings.filter((candidate) => candidate.level === 3)) {
    const { base } = splitQualifiedHeading(heading.text);
    byBase.set(base, [...(byBase.get(base) ?? []), heading]);
  }
  const homonyms = new Map<string, Set<string>>();
  for (const entry of registry.terms) {
    if (!entry.senses) continue;
    homonyms.set(
      entry.term.toLowerCase(),
      new Set(entry.senses.map((sense) => sense.qualifier.trim().toLowerCase()))
    );
  }
  for (const [base, group] of byBase) {
    if (group.length < 2) continue;
    const declared = homonyms.get(base);
    const undeclared = group.filter((heading) => {
      const { qualifier } = splitQualifiedHeading(heading.text);
      return !declared || !qualifier || !declared.has(qualifier);
    });
    if (undeclared.length > 0) {
      failures.push(
        `${GLOSSARY}: "${base}" is defined ${group.length} times (lines ${group
          .map((heading) => heading.line)
          .join(', ')}) — merge them, or declare each qualifier as a sense in ${CONCEPT_REGISTRY}`
      );
    }
  }

  const termHeadings = new Map(
    headings
      .filter((heading) => heading.level === 3)
      .map((heading) => [splitQualifiedHeading(heading.text).base, heading] as const)
  );
  for (const entry of registry.terms) {
    for (const alias of entry.aliases ?? []) {
      const heading = termHeadings.get(alias.trim().toLowerCase());
      if (heading && heading.slug !== entry.glossary_anchor) {
        failures.push(
          `${GLOSSARY}: alias "${alias}" of ${entry.id} has its own definition (line ${heading.line}) — drop the alias or register it as a separate term`
        );
      }
    }
  }

  const vocabulary = collectContributorVocabulary(glossary);
  for (const entry of registry.terms) {
    for (const name of [entry.term, ...(entry.aliases ?? [])]) {
      const cell = vocabulary.get(name.toLowerCase());
      if (cell !== undefined && cell !== entry.definition) {
        failures.push(
          `${GLOSSARY}: Contributor vocabulary row "${name}" must equal the registry definition of ${entry.id}: "${entry.definition}"`
        );
      }
    }
  }
  return failures;
}

// ---------------------------------------------------------------------------
// C4/C5 — retirement lifecycle
// ---------------------------------------------------------------------------

interface SourceCategory {
  id?: string;
  canonical?: string;
  index?: string;
  supporting?: string[];
  historical?: string[];
  scoped_sources?: Array<{ path?: string }>;
}

export function sourceMapActivePaths(sourceMap: { categories?: unknown }): string[] {
  const categories = Array.isArray(sourceMap.categories)
    ? (sourceMap.categories as SourceCategory[])
    : [];
  return categories.flatMap((category) => [
    ...(category.canonical ? [category.canonical] : []),
    ...(category.index ? [category.index] : []),
    ...(category.supporting ?? []),
    ...(category.scoped_sources ?? []).flatMap((source) => (source.path ? [source.path] : [])),
  ]);
}

export function checkRetiredDocument(view: RepoView, relativePath: string): string[] {
  const fields = frontmatterOf(view, relativePath);
  if (!fields?.doc_status) return [];
  const failures: string[] = [];
  if (relativePath.startsWith(`${PLAN_ROOT}/improvement-plans-`)) {
    return [
      `${relativePath}: improvement plans use their own status (planned|active|partial|completed|archived), not doc_status`,
    ];
  }
  if (!(DOC_STATUSES as readonly string[]).includes(fields.doc_status)) {
    failures.push(
      `${relativePath}: doc_status must be one of ${DOC_STATUSES.join('|')} (omit it for current docs)`
    );
    return failures;
  }
  if (fields.doc_status === 'superseded') {
    const target = stripAnchor(fields.superseded_by ?? '').file;
    if (!target) {
      failures.push(`${relativePath}: doc_status superseded requires superseded_by`);
    } else if (!view.exists(target)) {
      failures.push(
        `${relativePath}: superseded_by does not exist: ${target} (paths are repo-root-relative, e.g. knowledge/product/architecture/x.md)`
      );
    } else if (retiredStatus(view, target)) {
      failures.push(`${relativePath}: superseded_by points at a retired doc: ${target}`);
    }
  }
  return failures;
}

export function checkRetirementReferences(
  registry: ConceptRegistry,
  sourceMap: { categories?: unknown },
  view: RepoView
): string[] {
  const failures: string[] = [];
  for (const active of sourceMapActivePaths(sourceMap)) {
    const status = retiredStatus(view, active);
    if (status) {
      failures.push(
        `${DOCUMENTATION_SOURCE_MAP}: ${active} is doc_status ${status} — move it to that category's historical list`
      );
    }
  }
  for (const entry of registry.terms) {
    const { file } = stripAnchor(entry.canonical_doc);
    const status = retiredStatus(view, file);
    if (status) {
      failures.push(`registry: ${entry.id} canonical_doc ${file} is doc_status ${status}`);
    }
  }
  return failures;
}

// ---------------------------------------------------------------------------
// C6 — architecture docs map onto registered concepts (shrink-only baseline)
// ---------------------------------------------------------------------------

/** Every markdown file under a root, recursively (repo-relative paths). */
export function walkMarkdown(view: RepoView, root: string): string[] {
  if (!view.isDirectory(root)) return [];
  const out: string[] = [];
  for (const name of view.list(root)) {
    const child = `${root}/${name}`;
    if (view.isDirectory(child)) out.push(...walkMarkdown(view, child));
    else if (name.endsWith('.md')) out.push(child);
  }
  return out.sort();
}

export function listArchitectureDocs(view: RepoView): string[] {
  return walkMarkdown(view, ARCHITECTURE_ROOT);
}

/** Roots scanned for doc_status anywhere. Personal/confidential tiers are never read here. */
export const DOC_STATUS_ROOTS = ['docs', 'knowledge/product', 'knowledge/public'] as const;

export function architectureDocsWithoutConcepts(view: RepoView): string[] {
  return listArchitectureDocs(view).filter((doc) => {
    const fields = frontmatterOf(view, doc);
    return !fields?.doc_status && !(parseInlineList(fields?.concepts) ?? []).length;
  });
}

export function checkArchitectureConcepts(
  registry: ConceptRegistry,
  baseline: ConceptRegistryBaseline,
  view: RepoView
): string[] {
  const failures: string[] = [];
  const ids = new Set(registry.terms.map((entry) => entry.id));
  const allowed = new Set(baseline.architecture_docs_without_concepts);
  const missing = new Set(architectureDocsWithoutConcepts(view));

  for (const doc of listArchitectureDocs(view)) {
    failures.push(...checkRetiredDocument(view, doc));
    const fields = frontmatterOf(view, doc);
    if (fields?.concepts !== undefined) {
      const concepts = parseInlineList(fields.concepts);
      if (concepts === null) {
        failures.push(`${doc}: concepts must be an inline list, e.g. concepts: [mission, tenant]`);
      } else {
        for (const concept of concepts) {
          if (!ids.has(concept)) {
            failures.push(
              `${doc}: concepts lists unregistered id "${concept}" — register it in ${CONCEPT_REGISTRY} first`
            );
          }
        }
      }
    }
    if (missing.has(doc) && !allowed.has(doc)) {
      failures.push(
        `${doc}: new architecture docs must declare concepts: [<registry ids>] (or doc_status when retiring)`
      );
    }
  }
  for (const doc of allowed) {
    if (!missing.has(doc)) {
      failures.push(
        `baseline: ${doc} no longer needs an exemption — remove it (run with --prune-baseline)`
      );
    }
  }
  return failures;
}

// ---------------------------------------------------------------------------
// C7 — monthly plan indexes
// ---------------------------------------------------------------------------

export function listMonthlyPlanDirs(view: RepoView): string[] {
  if (!view.isDirectory(PLAN_ROOT)) return [];
  return view
    .list(PLAN_ROOT)
    .filter((name) => /^improvement-plans-\d{4}-(0[1-9]|1[0-2])$/u.test(name))
    .map((name) => `${PLAN_ROOT}/${name}`)
    .filter((dir) => view.isDirectory(dir))
    .sort();
}

export function checkPlanIndexes(sourceMap: { categories?: unknown }, view: RepoView): string[] {
  const failures: string[] = [];
  const dirs = listMonthlyPlanDirs(view);
  for (const dir of dirs) {
    const readme = `${dir}/README.ja.md`;
    const plans = view
      .list(dir)
      .filter((name) => name.endsWith('.md') && name !== 'README.ja.md')
      .sort();
    if (!view.exists(readme)) {
      if (plans.length)
        failures.push(`${dir}: missing README.ja.md index for ${plans.length} plans`);
      continue;
    }
    const linked = new Set(
      collectLinkTargets(view.read(readme)).map((target) =>
        path.posix.normalize(path.posix.join(dir, stripAnchor(target).file))
      )
    );
    for (const plan of plans) {
      if (!linked.has(`${dir}/${plan}`)) failures.push(`${readme}: does not link ${plan}`);
    }
  }
  const categories = Array.isArray(sourceMap.categories)
    ? (sourceMap.categories as SourceCategory[])
    : [];
  const statusCanonical = categories.find((category) => category.id === 'status')?.canonical;
  if (statusCanonical && view.exists(statusCanonical)) {
    const ownDir = path.posix.dirname(statusCanonical);
    const targets = collectLinkTargets(view.read(statusCanonical)).map((target) =>
      path.posix.normalize(path.posix.join(ownDir, stripAnchor(target).file))
    );
    for (const dir of dirs) {
      const readme = `${dir}/README.ja.md`;
      if (dir === ownDir || !view.exists(readme)) continue;
      if (!targets.includes(readme)) {
        failures.push(`${statusCanonical}: status index must link ${readme}`);
      }
    }
  }
  return failures;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export function checkConceptRegistry(view: RepoView, baseline: ConceptRegistryBaseline): string[] {
  const registry = JSON.parse(view.read(CONCEPT_REGISTRY)) as ConceptRegistry;
  const sourceMap = JSON.parse(view.read(DOCUMENTATION_SOURCE_MAP)) as { categories?: unknown };
  const failures = validateRegistry(registry, view);
  if (failures.some((failure) => failure.startsWith('registry: terms'))) return failures;
  for (const root of DOC_STATUS_ROOTS) {
    for (const doc of walkMarkdown(view, root)) {
      if (!doc.startsWith(`${ARCHITECTURE_ROOT}/`))
        failures.push(...checkRetiredDocument(view, doc));
    }
  }
  return [
    ...failures,
    ...checkGlossary(registry, view.read(GLOSSARY)),
    ...checkRetirementReferences(registry, sourceMap, view),
    ...checkArchitectureConcepts(registry, baseline, view),
    ...checkPlanIndexes(sourceMap, view),
  ];
}

export function createCheckoutView(): RepoView {
  const resolve = (relativePath: string) => pathResolver.rootResolve(relativePath);
  return {
    exists: (relativePath) => safeExistsSync(resolve(relativePath)),
    isDirectory: (relativePath) =>
      safeExistsSync(resolve(relativePath)) && safeLstat(resolve(relativePath)).isDirectory(),
    read: (relativePath) => readTextFile(resolve(relativePath)),
    list: (relativeDir) => safeReaddir(resolve(relativeDir)),
  };
}

function readBaseline(baselinePath: string): ConceptRegistryBaseline {
  if (!safeExistsSync(baselinePath)) return { version: 1, architecture_docs_without_concepts: [] };
  return JSON.parse(readTextFile(baselinePath)) as ConceptRegistryBaseline;
}

/** Drops exemptions that are no longer needed. Never adds an entry. */
export function pruneBaseline(
  baseline: ConceptRegistryBaseline,
  view: RepoView
): ConceptRegistryBaseline {
  const missing = new Set(architectureDocsWithoutConcepts(view));
  return {
    ...(baseline.$schema ? { $schema: baseline.$schema } : {}),
    version: 1,
    architecture_docs_without_concepts: baseline.architecture_docs_without_concepts.filter((doc) =>
      missing.has(doc)
    ),
  };
}

export const runCheckConceptRegistry = defineScript({
  name: 'check:concept-registry',
  flags: [],
  run(context) {
    const view = createCheckoutView();
    const baselinePath = resolveCiGateBaselinePath(GATE_ID);
    let baseline = readBaseline(baselinePath);
    if (context.unknownFlags.includes('--prune-baseline')) {
      const pruned = pruneBaseline(baseline, view);
      withExecutionContext('ecosystem_architect', () => writeJson(baselinePath, pruned));
      baseline = pruned;
    }
    const failures = checkConceptRegistry(view, baseline);
    if (failures.length) {
      throw new ScriptExitError(
        1,
        ['violations detected:', ...failures.map((failure) => `- ${failure}`)].join('\n')
      );
    }
    const registry = JSON.parse(view.read(CONCEPT_REGISTRY)) as ConceptRegistry;
    context.print(
      `[check:concept-registry] OK (${registry.terms.length} terms, ${baseline.architecture_docs_without_concepts.length} baseline exemptions, ${path.basename(baselinePath)})`
    );
    return { failures };
  },
});

if (
  isDirectScript(import.meta.url, 'check_concept_registry.ts') ||
  isDirectScript(import.meta.url, 'check_concept_registry.js')
)
  void runCheckConceptRegistry();
