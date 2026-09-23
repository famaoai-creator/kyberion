// UI-04: `/ui-gallery` + `/shared-ui/kyberion-ui.js` (presence-studio).
//
// Like the other route contract tests here, this never imports `server.ts`
// (it listens at module scope). It exercises `registerUiGalleryRoutes`
// against a recording app, reads the runtime module as text to prove the
// wiring, and validates the gallery fixture against the kyberion-base
// catalog schema so gallery data can never drift from the catalog.
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { pathResolver, safeExistsSync, safeReadFile } from '@agent/core';
import {
  KYBERION_BASE_COMPONENT_TYPES,
  isKyberionBaseComponentType,
  validateA2UIComponentProps,
} from '@agent/core/a2ui-catalog';
import {
  SHARED_UI_VANILLA_ROUTE,
  SHARED_UI_VANILLA_SOURCE,
  UI_GALLERY_ROUTE,
  registerUiGalleryRoutes,
} from './ui-gallery-routes.js';

const STATIC_DIR = 'presence/displays/presence-studio/static';

function readRepoFile(relativePath: string): string {
  return String(safeReadFile(pathResolver.rootResolve(relativePath), { encoding: 'utf8' }));
}

interface FixtureComponent {
  id: string;
  type: string;
  props: Record<string, unknown>;
  children?: string[];
}

interface GalleryFixtures {
  version: number;
  catalog: string;
  sample_screen: { title: string; root: string; components: FixtureComponent[] };
  sections: Array<{ id: string; title: string; components: FixtureComponent[] }>;
}

const fixtures = JSON.parse(
  readRepoFile(`${STATIC_DIR}/ui-gallery.fixtures.json`)
) as GalleryFixtures;
const componentLists: Array<[string, FixtureComponent[]]> = [
  ['sample_screen', fixtures.sample_screen.components],
  ...fixtures.sections.map((s): [string, FixtureComponent[]] => [s.id, s.components]),
];

describe('ui-gallery fixtures', () => {
  it('targets the kyberion-base catalog', () => {
    expect(fixtures.catalog).toBe('kyberion-base');
    expect(new Set(fixtures.sections.map((s) => s.id)).size).toBe(fixtures.sections.length);
  });

  for (const [listId, components] of componentLists) {
    it(`${listId}: every component is a catalog type with schema-valid props`, () => {
      for (const component of components) {
        expect(isKyberionBaseComponentType(component.type), `${listId}/${component.id}`).toBe(true);
        expect(
          () => validateA2UIComponentProps(component.type as never, component.props),
          `${listId}/${component.id}`
        ).not.toThrow();
      }
    });

    it(`${listId}: ids are unique and every child reference resolves`, () => {
      const ids = components.map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const component of components) {
        for (const child of component.children ?? []) {
          expect(ids, `${listId}/${component.id} -> ${child}`).toContain(child);
        }
      }
    });
  }

  it('shows every catalog type at least once', () => {
    const shown = new Set(componentLists.flatMap(([, list]) => list.map((c) => c.type)));
    const missing = KYBERION_BASE_COMPONENT_TYPES.filter((type) => !shown.has(type));
    expect(missing).toEqual([]);
  });

  it('composes the sample screen from an app-shell root with the key building blocks', () => {
    const { root, components } = fixtures.sample_screen;
    const byId = new Map(components.map((c) => [c.id, c]));
    expect(byId.get(root)?.type).toBe('ui:app-shell');
    const types = new Set(components.map((c) => c.type));
    for (const type of [
      'ui:nav-rail',
      'ui:page-header',
      'ui:next-action',
      'ui:metric',
      'ui:table',
      'ui:callout',
      'ui:empty-state',
    ]) {
      expect(types.has(type), type).toBe(true);
    }
    const header = components.find((c) => c.type === 'ui:page-header');
    expect(header?.props.role_badge).toBeTruthy();
  });
});

describe('ui-gallery routes', () => {
  function recordRoutes() {
    const routes = new Map<string, (req: unknown, res: unknown) => void>();
    const app = {
      get(route: string, handler: (req: unknown, res: unknown) => void) {
        routes.set(route, handler);
      },
    };
    registerUiGalleryRoutes(app as never, '/static-root');
    return routes;
  }

  function fakeResponse() {
    const res = {
      sent: '',
      contentType: '',
      headers: {} as Record<string, string>,
      sendFile(file: string) {
        res.sent = file;
      },
      type(value: string) {
        res.contentType = value;
        return res;
      },
      setHeader(name: string, value: string) {
        res.headers[name] = value;
      },
    };
    return res;
  }

  it('serves the gallery page and the vanilla renderer from fixed files', () => {
    const routes = recordRoutes();
    expect([...routes.keys()].sort()).toEqual([SHARED_UI_VANILLA_ROUTE, UI_GALLERY_ROUTE].sort());

    const page = fakeResponse();
    routes.get(UI_GALLERY_ROUTE)!({}, page);
    expect(page.sent).toBe(path.join('/static-root', 'ui-gallery.html'));

    const script = fakeResponse();
    routes.get(SHARED_UI_VANILLA_ROUTE)!({}, script);
    expect(script.sent).toBe(pathResolver.rootResolve(SHARED_UI_VANILLA_SOURCE));
    expect(script.contentType).toMatch(/^text\/javascript/);
    expect(safeExistsSync(script.sent)).toBe(true);
  });

  it('is wired into the presence-studio runtime', () => {
    const runtime = readRepoFile(
      'presence/displays/presence-studio/presence-studio-runtime-data.ts'
    );
    expect(runtime).toContain("import { registerUiGalleryRoutes } from './ui-gallery-routes.js';");
    expect(runtime).toContain('registerUiGalleryRoutes(app, staticDir);');
  });

  it('the page loads the shared tokens, component CSS and renderer', () => {
    const page = readRepoFile(`${STATIC_DIR}/ui-gallery.html`);
    expect(page).toContain('href="/design-tokens.css"');
    expect(page).toContain('href="/kyberion-ui.css"');
    expect(page).toContain('src="/ui-gallery.js"');
    const script = readRepoFile(`${STATIC_DIR}/ui-gallery.js`);
    expect(script).toContain(`from '${SHARED_UI_VANILLA_ROUTE}'`);
    expect(script).not.toMatch(/innerHTML|insertAdjacentHTML|document\.write/);
  });

  it('the gallery stylesheet uses tokens only (no literal colors)', () => {
    const css = readRepoFile(`${STATIC_DIR}/ui-gallery.css`);
    expect(css.match(/#[0-9a-f]{3,8}\b|\brgba?\s*\(|\bhsla?\s*\(/giu)).toBeNull();
  });
});
