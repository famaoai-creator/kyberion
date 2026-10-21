# A2UI Host

A standalone viewer for any A2UI producer, built on its own small framework
rather than on another surface's pages. It loads A2UI messages from a
provider (through a loopback-only proxy), applies them to a surface store,
renders them with a fixed component catalog, and exposes what happened
(actions, data model, component tree, message history) in an inspector.

## Run

```bash
pnpm run build:repo                      # emits dist/presence/displays/a2ui-host/**
node dist/presence/displays/a2ui-host/server.js
open http://127.0.0.1:3036/
```

Environment (both registered in `knowledge/product/governance/env-registry.json`):

| Variable                       | Default                                                         | Meaning                                           |
| ------------------------------ | --------------------------------------------------------------- | ------------------------------------------------- |
| `KYBERION_A2UI_HOST_PORT`      | `3036`                                                          | Loopback port                                     |
| `KYBERION_A2UI_HOST_PROVIDERS` | `presence-studio=http://127.0.0.1:3031,computer-surface=…:3040` | `id=base_url` list; loopback http(s) origins only |

## Layout

```
server.ts                 Express entry (loopback, CSP, process guards)
src/framework/            the framework — no DOM, no I/O, testable in node
  protocol.ts             message/component validation (mirrors @agent/core/a2ui)
  store.ts                SurfaceStore: apply → surfaces + bounded history; tree()
  registry.ts             component type → renderer; fallback for unknown types
  catalog.ts              standard component set (text, button, card, container, display:*)
  renderer.ts             renderSurface(container, store, id, { adapter, registry, onAction })
  dom.ts                  DomAdapter seam: browser adapter + fake adapter for tests
  actions.ts              action descriptors, path policy, runAction(fetch, target, action)
  envelope.ts             find A2UI inside producer responses
src/server/               host routes: /api/providers, /:id/catalog, /:id/proxy/api/…
src/app/                  the viewer page logic (main.ts) and its ja/en strings
static/                   index.html + app.css (own tokens, light/dark)
```

The browser loads `src/**` as ES modules from `dist/` (`/js/app/main.js`);
no bundler is involved. Type-only imports from `@agent/core` are erased, so
the framework has zero runtime dependencies in the browser.

## Contracts the host keeps

- Text only through text nodes; no `innerHTML`, no inline scripts or handlers
  (`Content-Security-Policy: script-src 'self'`).
- Producers are reached only through `/api/providers/:id/proxy/api/...`;
  unknown providers, non-`/api/` paths and non-GET/POST methods are refused.
- Actions are accepted only as `{ operation_id, method, path: '/api/...' }`;
  everything else renders as a disabled button.
- Unknown component types render as a visible placeholder and are listed in
  the render report; invalid messages become `rejected` history entries.
- Recursion depth is bounded (`MAX_RENDER_DEPTH`), history is bounded
  (`DEFAULT_MAX_HISTORY`).

## Extending

- New component type: `registry.define({ type, description, props, render })`
  in `catalog.ts` (or a second catalog module) and a matching class block in
  `static/app.css`. Renderers receive a `RenderContext` — use `ctx.h`,
  `ctx.prop`, `ctx.renderChildren`, `ctx.renderInline`, `ctx.dispatch`.
- New producer: add `id=base_url` to `KYBERION_A2UI_HOST_PROVIDERS`. It
  should publish `GET /api/headless/manifest` (resources with `a2ui_path`)
  and answer `a2ui_path` with `{ data: { a2ui: [...] } }` or a message array.
- Data binding: any prop may be `{ "$ref": "path.in.data.model" }`.

## Tests

```bash
npx vitest run presence/displays/a2ui-host
```

Framework tests use the fake DOM adapter; route tests start the Express app
on an ephemeral port with a fake upstream.
