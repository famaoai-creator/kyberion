# Personal pads (one localhost capture desk)

`pnpm pads` starts one **127.0.0.1-only** server. Choose a pad from the menu, set the visible tier, save, and inspect the authenticated history without starting a separate port for every pad. Shared request helpers live in `scripts/lib/local-artifact-pad.ts`; durable records use `scripts/personal-pads/storage.ts`. Pad-specific input and canonical capture formatting are adapter seams in `scripts/personal-pads/adapters.ts`; the shell/client runtime renders their field descriptors, so a new menu item does not require a new HTTP route.

```bash
KYBERION_TENANT=<tenant-slug> KYBERION_VIEWER_PRINCIPAL=human:<id> pnpm pads
# open http://127.0.0.1:8160/
```

`KYBERION_TENANT` is required for `personal` and `confidential` data. The server derives the tenant and viewer from its environment; query parameters and browser state can only select a tier within that server scope. The browser never receives a physical storage path. Records are stored under `active/shared/local-pads/{tier}/{tenant}/[context/]/{owner}/{pad}/` and are indexed for history. `X-Pads-Token` (or a bearer token) and localhost Origin are required for API calls.

`KYBERION_WORKING_MEMORY_ROOT` (when configured for Daily desk) follows the same owner boundary: `tenant/owners/<principal-hash>/`. The unified workbench writes email drafts locally, creates calendar proposals only after an explicit approval record, and refuses to retry an uncertain external calendar write automatically.

The host seam is `PERSONAL_PADS_SURFACE`: `getMenu`, `getContent`, `getHistory`, `getTop`, and `resolveStoragePolicyId` are injected together with the public adapter contract. A host can replace or compose the menu/content without adding pad-specific branches to the HTTP server or browser runtime. Hosts may also override the optional `getActionAvailability` and `executeAction` seams for embedded readiness/actions; the default implementation uses the typed handler registry in `scripts/personal-pads/actions.ts`. Pad-specific operations are declared as safe action descriptors (including optional typed `input_fields`) and dispatched through one common route; `POST /api/action` returns a draft patch or governed proposal, never an arbitrary path or command. `GET /api/action-readiness` reports capability and OS-permission preflight without running the action.

Legacy routes are normalized by `scripts/personal-pads/legacy.ts`: each legacy server calls `composeLegacyCapture` before writing its historical handoff, and unified records include a stable `compatibility` handoff projection (`kind`, typed payload, artifact manifest). This keeps old follow-up tooling usable while the shell moves to the shared record store. Daily desk accepts an explicit `period_key`; only the current day uses the owner-root face, while historical dates use `tenant/owners/<principal-hash>/daily/<YYYY-MM-DD>/` with no cross-date fallback.

Drawing fields can declare their own `drawing_tools`, image `overlay_field`, paste/drop support, voice-input affordance, and local PNG download in the adapter metadata. The shared client runtime renders these controls for Sketch and Screenshot, so future visual pads reuse the same component instead of adding pad-specific event handlers.

**UI kit and language (PA-04 / PA-07).** The page is built on the shared A2UI `kyberion-base` kit through `scripts/lib/pad-ui.ts` (`renderPadPage`, `/shared-ui/*`, theme + language display controls). The browser runtime is `client/app.js` (+ `client/support.js`), served at `/personal-pads/*.js`; it maps adapter field kinds to kit components — text / textarea → `ui:text-field` / `ui:textarea` (+ `ui:voice-input` dictation for `voice_input`), select → `ui:select`, file / image → `ui:file-drop`, recording → `ui:file-drop` + `ui:voice-input` (`record`), drawing → `ui:sketch-board` (an `overlay_field` image becomes the board background), actions → `ui:toolbar`, save / clear → `ui:save-bar`, history → `ui:list`, unsaved changes → `ui:dialog`. Every user-visible string is a `personal_pads:*` vocabulary key (registry, adapter and action definitions hold keys, resolved per request locale: `?lang=` → `kb-ui-locale` cookie → `Accept-Language`). API calls carry the page locale as `lang`, so action messages and composed record bodies follow the viewer's language.

| Pad                                            | Port | One-liner                                                         |
| ---------------------------------------------- | ---: | ----------------------------------------------------------------- |
| **personal-pads (unified desk)**               | 8160 | Menu, scoped durable storage, and authenticated history           |
| [memory-capture](../memory-capture/)           | 8149 | Brain-dump notes/tags → memory handoff                            |
| [screenshot-annotate](../screenshot-annotate/) | 8150 | Screenshot + annotations → vision handoff                         |
| [clipboard-inbox](../clipboard-inbox/)         | 8151 | Clipboard snippets → inbox handoff                                |
| [daily-desk](../daily-desk/)                   | 8152 | Journal / TODO / NOW desk → daily-desk handoff                    |
| [doc-drop](../doc-drop/)                       | 8153 | File drop (pdf/images/txt/md/docx) → ingest handoff               |
| [personal-workbench](../personal-workbench/)   | 8154 | Link / task / follow-up / decision / expense / daily review inbox |

## Quick dry-run

```bash
pnpm pads -- --dry-run --json --tier public
node_modules/.bin/tsx scripts/daily-desk/server.ts --dry-run --json
node_modules/.bin/tsx scripts/doc-drop/server.ts --dry-run --json
```

API endpoints on the unified server are `GET /api/pads`, `GET /api/context`, `GET /api/action-readiness?pad=<id>`, `GET /api/history?pad=<id>`, `GET /api/history/<record-id>?pad=<id>`, `GET /api/history/<record-id>?pad=<id>&artifact=<artifact-id>`, `POST /api/capture`, and `POST /api/action`. The capture body is `{pad_id,title,body,fields?,tier,artifact_manifest?}`; `fields` is parsed, validated, and composed by the selected adapter, binary field data is promoted to the scoped artifact store, and `tier` must match the server-derived request scope. An action body is `{pad_id,action_id,title?,body?,fields?,record_id?,tier}` and is accepted only when the adapter declares that action. Meeting recording and document drop use the same generic recording/multi-file field components; original bytes remain managed artifacts.

To add a pad, register its ID and policy in `registry.ts`, implement its typed field/compose contract in `adapters.ts`, optionally declare action descriptors, and add the executor plus focused tests in `actions.ts`. If a host needs a different catalog, inject a `PersonalPadsSurface` with the same seam methods. The server, history API, storage resolver, menu shell, action dispatcher, and tier authorization remain shared.

Legacy handoffs can be inventoried before import. Dry-run is the default; `--apply` is explicit and keeps the source files unchanged:

```bash
pnpm exec tsx scripts/personal-pads/migrate.ts --dry-run --json
pnpm exec tsx scripts/personal-pads/migrate.ts --apply --json
```

Legacy pad servers remain available during migration and continue to use their documented ports. They do not start automatically when `pnpm pads` is used.

Related: `scripts/meeting-notepad/` (8148), `scripts/sketch-input/` (8147), `scripts/report-review/` (8137).

Screenshots of every pad live in `docs/assets/pads/` and are shown in the [README gallery](../../README.md#local-pads--capture-at-your-desk-hand-off-to-kyberion).
