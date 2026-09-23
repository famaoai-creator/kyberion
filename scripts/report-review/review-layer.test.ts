import { describe, expect, it } from 'vitest';
import {
  buildReviewLayerData,
  buildReviewLayerModuleBundle,
  REVIEW_LAYER_KIT_ENTRY,
  REVIEW_LAYER_MODULE_PLACEHOLDER,
  reviewLayerMarkup,
  reviewLayerModuleBundle,
  RV_LAYER_CLOSE,
  RV_LAYER_OPEN,
} from './review-layer.js';

function layerData(markup: string): Record<string, unknown> {
  const match = /<script type="application\/json" id="rv-layer-data">([\s\S]*?)<\/script>/.exec(
    markup
  );
  return JSON.parse(match?.[1] ?? '{}') as Record<string, unknown>;
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('report review layer markup', () => {
  const inline = reviewLayerMarkup({ locale: 'en' });
  const served = reviewLayerMarkup({ locale: 'ja', assets: 'served' });

  it('keeps exactly one marker pair around the whole layer', () => {
    for (const markup of [inline, served]) {
      expect(markup.startsWith(RV_LAYER_OPEN)).toBe(true);
      expect(markup.endsWith(RV_LAYER_CLOSE)).toBe(true);
      // Server save / stamp --remove strip non-greedily between the markers.
      expect(count(markup, RV_LAYER_OPEN)).toBe(1);
      expect(count(markup, RV_LAYER_CLOSE)).toBe(1);
      expect(count(markup, 'id="rv-bar"')).toBe(1);
    }
  });

  it('renders a shadow-root host and no native dialogs', () => {
    expect(inline).toContain('<kb-review-layer id="rv-bar" contenteditable="false"');
    expect(inline).toContain('mark.rv-cmt{');
    // The served layer carries no kit sources (whose comments mention window.confirm()).
    expect(served).not.toMatch(/\b(?:confirm|prompt|alert)\(/);
    const script = /<script type="module">([\s\S]*?)<\/script>/.exec(inline)?.[1] ?? '';
    expect(script).toContain('attachShadow');
    expect(script).not.toMatch(/\b(?:confirm|prompt|alert)\(/);
  });

  it('carries the locale vocabulary for the layer', () => {
    const en = layerData(inline);
    const ja = layerData(served);

    expect(en.locale).toBe('en');
    expect((en.texts as Record<string, string>)['report_review:comment_dialog_title']).toBe(
      'Add a comment'
    );
    expect(ja.locale).toBe('ja');
    expect((ja.texts as Record<string, string>)['report_review:comment_dialog_title']).toBe(
      'コメントを追加'
    );
    expect((ja.messages as Record<string, string>)['ui:dialog_cancel']).toBeTruthy();
  });

  it('points a served layer at the pad-ui renderer and bundles the kit for offline use', () => {
    const servedData = layerData(served);
    expect(servedData).toMatchObject({ assets: 'served', renderer: '/shared-ui/kyberion-ui.js' });
    expect(servedData.modules).toBeUndefined();

    const inlineData = layerData(inline);
    expect(inlineData).toMatchObject({
      assets: 'inline',
      entry: REVIEW_LAYER_KIT_ENTRY,
      placeholder: REVIEW_LAYER_MODULE_PLACEHOLDER,
    });
    const modules = inlineData.modules as Array<{ name: string; source: string; deps: string[] }>;
    expect(modules.at(-1)?.name).toBe(REVIEW_LAYER_KIT_ENTRY);
  });

  it('scopes the kit stylesheet to the shadow host', () => {
    const css = String(layerData(inline).css);
    expect(css).not.toMatch(/:root\b/);
    expect(css).toContain(':host {');
    expect(css).toContain('.kb-toolbar');
    expect(css).toContain('.kb-dialog');
  });
});

describe('report review layer kit bundle', () => {
  it('orders dependencies first and leaves no relative import behind', () => {
    const bundle = reviewLayerModuleBundle();
    const seen = new Set<string>();
    for (const module of bundle) {
      for (const dep of module.deps) expect(seen.has(dep)).toBe(true);
      expect(module.source).not.toMatch(/(?:from\s*|import\s*\(?\s*)['"]\.\/[a-z0-9-]+\.js['"]/);
      seen.add(module.name);
    }
    expect([...seen]).toEqual(
      expect.arrayContaining(['kyberion-ui.js', 'dialog.js', 'toolbar.js'])
    );
    expect(bundle.map((module) => module.name)).not.toContain('pad-client.js');
  });

  it('rewrites static, re-export and dynamic imports and rejects cycles', () => {
    const files: Record<string, string> = {
      'kyberion-ui.js':
        "import { a } from './a.js';\nexport * from \"./b.js\";\nconst lazy = () => import('./a.js');",
      'a.js': "import './b.js';\nexport const a = 1;",
      'b.js': 'export const b = 2;',
    };
    const bundle = buildReviewLayerModuleBundle((name) => files[name] ?? null);
    expect(bundle.map((module) => module.name)).toEqual(['b.js', 'a.js', 'kyberion-ui.js']);
    expect(bundle[2].deps).toEqual(['a.js', 'b.js']);
    expect(bundle[2].source).toContain(`from '${REVIEW_LAYER_MODULE_PLACEHOLDER}a.js'`);
    expect(bundle[2].source).toContain(`from "${REVIEW_LAYER_MODULE_PLACEHOLDER}b.js"`);
    expect(bundle[2].source).toContain(`import('${REVIEW_LAYER_MODULE_PLACEHOLDER}a.js')`);

    const cyclic: Record<string, string> = {
      'kyberion-ui.js': "import './a.js';",
      'a.js': "import './kyberion-ui.js';",
    };
    expect(() => buildReviewLayerModuleBundle((name) => cyclic[name] ?? null)).toThrow(
      'import cycle'
    );
  });
});

describe('review layer shadow CSS', () => {
  it('carries the tokens on :host (generated), never :root', () => {
    const css = String(buildReviewLayerData({ locale: 'en' }).css);
    expect(css).toContain(':host {');
    expect(css).toContain(':host([data-theme="dark"])');
    expect(css).toContain(':host(:not([data-theme="light"]))');
    expect(css).not.toContain(':root');
    expect(css).toContain('.kb-toolbar');
  });
});
