// UI-03/UI-04 parity: the React renderer (`A2UIRenderer`) and the vanilla
// renderer (`libs/shared-ui/vanilla/kyberion-ui.js`) must emit the same
// markup for the `kyberion-base` catalog (the CSS contract in
// `knowledge/public/design-patterns/web/kyberion-ui.source.css` styles both
// by the same classes / BEM elements / data attributes).
//
// For every fixture in `ui-gallery.fixtures.{en,ja}.json` (which exercises every
// `ui:*` catalog type at least once — see the coverage check below), render
// with both renderers, normalise away renderer-specific noise (attribute
// order, whitespace, boolean-attribute representation, React-only attrs like
// `data-reactroot`) and assert the DOM trees agree on: tag, class, `data-*`
// / `aria-*` / `role` / `href` attributes, and text.
//
// UI-01d: runs once per locale (en, ja) with that locale's fixture file and
// its `ui` vocabulary bundle (`getUiMessageBundle`), so renderer-default text
// (status labels, empty/loading text, trend words) must also agree.
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { getUiMessageBundle, pathResolver, safeReadFile, type SupportedLocale } from '@agent/core';
import { renderA2UI } from '../vanilla/kyberion-ui.js';
import { MiniDocument, MiniElement, MiniText } from '../vanilla/mini-dom.test-support.js';
import { A2UIRenderer, KB_COMPONENT_TYPES, type A2UIRendererComponent } from './index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface FixtureScenario {
  id: string;
  title: string;
  rootId?: string;
  components: A2UIRendererComponent[];
}

interface FixtureFile {
  version: number;
  catalog: string;
  sample_screen: {
    title: string;
    root: string;
    components: A2UIRendererComponent[];
  };
  sections: Array<{
    id: string;
    title: string;
    components: A2UIRendererComponent[];
  }>;
}

const LOCALES: readonly SupportedLocale[] = ['en', 'ja'];

function loadFixtures(locale: SupportedLocale): FixtureScenario[] {
  const path = pathResolver.rootResolve(
    `presence/displays/presence-studio/static/ui-gallery.fixtures.${locale}.json`
  );
  const raw = String(safeReadFile(path, { encoding: 'utf8' }));
  const fixtures = JSON.parse(raw) as FixtureFile;
  expect(fixtures.catalog).toBe('kyberion-base');
  const scenarios: FixtureScenario[] = [
    {
      id: 'sample_screen',
      title: fixtures.sample_screen.title,
      rootId: fixtures.sample_screen.root,
      components: fixtures.sample_screen.components,
    },
    ...fixtures.sections.map((section) => ({
      id: section.id,
      title: section.title,
      components: section.components,
    })),
  ];
  return scenarios;
}

// ---------------------------------------------------------------------------
// Normalised DOM tree comparison
// ---------------------------------------------------------------------------
//
// Both sides collapse to the same shape: element nodes keep only `tag`, a
// sorted/deduped class list and the attributes the two renderers are
// contractually required to agree on (`data-*`, `aria-*`, `role`, `href`);
// everything else (attribute order, `type=`, `scope=`, `style=`, boolean
// attributes such as `disabled=""` vs a DOM property, React's own
// bookkeeping attrs, ...) is renderer-specific and dropped before comparing.

interface NormElement {
  tag: string;
  cls: string[];
  attrs: Record<string, string>;
  children: NormNode[];
}
type NormNode = NormElement | { text: string };

const KEEP_ATTR = /^(?:data-[\w-]+|aria-[\w-]+|role|href)$/;

function keepAttrs(
  names: Iterable<string>,
  get: (name: string) => string | null
): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const name of names) {
    if (!KEEP_ATTR.test(name)) continue;
    const value = get(name);
    if (value !== null) attrs[name] = value;
  }
  return attrs;
}

function classesOf(className: string): string[] {
  return className.split(/\s+/).filter(Boolean).sort();
}

// -- vanilla (MiniElement/MiniText) side -------------------------------------

function normalizeMiniNode(node: unknown): NormNode | null {
  if (node instanceof MiniText) {
    return node.data === '' ? null : { text: node.data };
  }
  if (node instanceof MiniElement) {
    return {
      tag: node.tagName.toLowerCase(),
      cls: classesOf(node.className),
      attrs: keepAttrs(node.getAttributeNames(), (name) => node.getAttribute(name)),
      children: node.childNodes
        .map((child) => normalizeMiniNode(child))
        .filter((child): child is NormNode => child !== null),
    };
  }
  return null;
}

interface LocaleOptions {
  locale: string;
  messages: Record<string, string>;
}

function normalizeVanilla(
  components: A2UIRendererComponent[],
  rootId: string | undefined,
  i18n: LocaleOptions
): NormNode[] {
  const document = new MiniDocument();
  const container = document.createElement('div');
  renderA2UI(container as unknown as Element, components as never, {
    document: document as unknown as Document,
    rootId,
    locale: i18n.locale,
    messages: i18n.messages,
  });
  return (container.childNodes as unknown[])
    .map((child) => normalizeMiniNode(child))
    .filter((child): child is NormNode => child !== null);
}

// -- React (renderToStaticMarkup HTML string) side ---------------------------

const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(input: string): string {
  return input.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith('#')) {
      const isHex = entity[1] === 'x' || entity[1] === 'X';
      const code = isHex ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[entity] ?? match;
  });
}

function parseTagAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:="([^"]*)")?/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) {
    attrs[match[1]] = match[2] !== undefined ? decodeEntities(match[2]) : '';
  }
  return attrs;
}

interface RawElement {
  tag: string;
  attrs: Record<string, string>;
  children: Array<RawElement | { text: string }>;
}

/** Parse `renderToStaticMarkup` output (well-formed, self-closes only true void elements). */
function parseStaticMarkup(html: string): NormNode[] {
  const root: { children: Array<RawElement | { text: string }> } = { children: [] };
  const stack: Array<{ children: Array<RawElement | { text: string }> }> = [root];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      const text = html.slice(i);
      if (text) stack[stack.length - 1].children.push({ text: decodeEntities(text) });
      break;
    }
    if (lt > i) {
      const text = html.slice(i, lt);
      if (text) stack[stack.length - 1].children.push({ text: decodeEntities(text) });
    }
    const gt = html.indexOf('>', lt);
    if (gt === -1) throw new Error(`parity: unterminated tag near "${html.slice(lt, lt + 40)}"`);
    const tagContent = html.slice(lt + 1, gt);
    i = gt + 1;
    if (tagContent.startsWith('/')) {
      stack.pop();
      continue;
    }
    const selfClose = tagContent.endsWith('/');
    const body = (selfClose ? tagContent.slice(0, -1) : tagContent).trim();
    const spaceIdx = body.search(/\s/);
    const tagName = (spaceIdx === -1 ? body : body.slice(0, spaceIdx)).toLowerCase();
    const attrsSource = spaceIdx === -1 ? '' : body.slice(spaceIdx + 1);
    const node: RawElement = { tag: tagName, attrs: parseTagAttrs(attrsSource), children: [] };
    stack[stack.length - 1].children.push(node);
    if (!selfClose && !VOID_ELEMENTS.has(tagName)) stack.push(node);
  }
  const toNorm = (node: RawElement | { text: string }): NormNode => {
    if ('text' in node) return node;
    return {
      tag: node.tag,
      cls: classesOf(node.attrs.class ?? ''),
      attrs: keepAttrs(Object.keys(node.attrs), (name) => node.attrs[name] ?? null),
      children: node.children.map(toNorm),
    };
  };
  return root.children.map(toNorm);
}

function normalizeReact(
  components: A2UIRendererComponent[],
  rootId: string | undefined,
  i18n: LocaleOptions
): NormNode[] {
  const html = renderToStaticMarkup(
    <A2UIRenderer
      components={components}
      rootId={rootId}
      locale={i18n.locale}
      messages={i18n.messages}
    />
  );
  return parseStaticMarkup(html);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/** Every text node in a normalised tree, in document order. */
function textsOf(nodes: NormNode[]): string[] {
  return nodes.flatMap((node) => ('text' in node ? [node.text] : textsOf(node.children)));
}

for (const locale of LOCALES) {
  const scenarios = loadFixtures(locale);
  const bundle = getUiMessageBundle(locale);

  describe(`React ↔ vanilla A2UI renderer parity (ui-gallery.fixtures.${locale}.json)`, () => {
    it('every kyberion-base catalog type appears in the fixtures at least once', () => {
      const used = new Set<string>();
      for (const scenario of scenarios) {
        for (const component of scenario.components) used.add(component.type);
      }
      for (const type of KB_COMPONENT_TYPES) {
        expect(used.has(type), `fixtures never use ${type}`).toBe(true);
      }
    });

    for (const scenario of scenarios) {
      it(`${scenario.id}: React and vanilla render identical trees`, () => {
        const reactTree = normalizeReact(scenario.components, scenario.rootId, bundle);
        const vanillaTree = normalizeVanilla(scenario.components, scenario.rootId, bundle);
        expect(reactTree).toEqual(vanillaTree);
      });
    }

    it('renderer-default text is in the requested locale', () => {
      const pills = scenarios.find((scenario) => scenario.id === 'status-pill');
      expect(pills).toBeTruthy();
      const texts = textsOf(normalizeVanilla(pills!.components, pills!.rootId, bundle));
      expect(texts).toContain(bundle.messages['ui:status_blocked']);
      expect(texts).toContain(bundle.messages['ui:status_ready']);
      const other = getUiMessageBundle(locale === 'en' ? 'ja' : 'en');
      expect(texts).not.toContain(other.messages['ui:status_blocked']);
    });
  });
}
