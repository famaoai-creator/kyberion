# Customer Room

The customer-facing screen of customer decision hearing (CD-07, plan
`docs/developer/improvement-plans-2026-10/CUSTOMER_DECISION_HEARING_PLAN_2026-10-24.ja.md`).
A customer opens an invite link, sees the items they are asked to decide or
comment on (question, background, what we are currently proceeding with and
whose proposal that is, options with cost/schedule/scope impact, "keep as is",
comment), confirms, and submits. Contributors' answers are recorded as opinions;
the decider's become the decision.

One process serves **one tenant**. It is operator-launched (`enabled: false` in
`knowledge/product/governance/surfaces/customer-room.json`) because it is
exposed publicly through the public ingress provider placed in front of it.
Through `pnpm surfaces` it runs as `SYSTEM_ROLE=customer_room`, which may assume
no role (`role-assumption-policy.json`): the room itself assumes none.

## Run

```bash
pnpm run build:repo          # emits dist/presence/displays/customer-room/** and dist/scripts/customer_decision.js
KYBERION_CUSTOMER_ROOM_TENANT=<tenant-slug> node dist/presence/displays/customer-room/server.js
```

| Variable                                 | Default | Meaning                                                                                                                       |
| ---------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `KYBERION_CUSTOMER_ROOM_TENANT`          | —       | **Required.** Tenant slug served. The process refuses to start without a valid one.                                           |
| `KYBERION_CUSTOMER_ROOM_PORT`            | `3046`  | Loopback port (the process binds `127.0.0.1` only).                                                                           |
| `KYBERION_CUSTOMER_ROOM_TRUSTED_PROXIES` | empty   | IPs / CIDRs of the reverse proxy in front (see [Behind the public ingress](#behind-the-public-ingress)). Empty trusts nobody. |

### Behind the public ingress

Behind Tailscale Funnel or another reverse proxy every request reaches the room
from the proxy's address, so the per-client rate limits would put every
customer in one bucket. List the proxy's addresses so the room reads the client
address from the forwarded headers — for a proxy on the same host (Tailscale
Funnel forwards from loopback):

```bash
KYBERION_CUSTOMER_ROOM_TRUSTED_PROXIES=127.0.0.1,::1
```

- The headers are read **only** when the direct peer is listed; from any other
  peer they are ignored, so a customer cannot pick their own bucket.
- `X-Forwarded-For` is walked from the right and the first hop that is not
  itself a listed proxy is the client (the leftmost value is whatever the
  client sent). Without `X-Forwarded-For`, RFC 7239 `Forwarded: for=` is used.
  List every proxy in a multi-proxy chain.
- A malformed, obfuscated (`unknown`, `_hidden`) or overlong chain keys on the
  nearest listed proxy (one shared bucket), never on a value it names.
- An entry that is not an IP or CIDR stops the room from starting. Express
  `trust proxy` stays off; the setting affects only the rate-limit keys.

Invite links are produced by `pnpm kyberion customer-decision send` as
`<KYBERION_CUSTOMER_ROOM_PUBLIC_URL>/r#t=<token>`.

## Boundary

Routes — everything else is a plain 404:

| Route                   | Purpose                                                            |
| ----------------------- | ------------------------------------------------------------------ |
| `GET /health`           | liveness                                                           |
| `GET /r`                | the page; the token is in the URL **fragment** and never sent here |
| `GET /assets/<css>`     | the page's stylesheets (fixed list)                                |
| `GET /js/app/<name>.js` | the page's compiled modules (no tests, no source maps)             |
| `POST /api/view`        | `Authorization: Bearer <token>`                                    |
| `POST /api/respond`     | `Authorization: Bearer <token>`, body `{content_hash, answers}`    |
| `POST /api/attachment`  | `Authorization: Bearer <token>`, body `{attachment_id}` (64 hex)   |

- `view` / `respond` / `attachment` run `dist/scripts/customer_decision.js <verb> --tenant <tenant> --json`
  as a child process (`src/server/facade.ts`), request on STDIN, with a time
  and output-size limit. The tenant comes only from the process environment;
  a `tenant`/`case`/`dir` in a body or query string is ignored (and the facade
  refuses `--dir` outside test runs).
- The child gets a minimal env (`facadeChildEnv`): the secure-io exec allowlist
  with any ambient `MISSION_ROLE` / `KYBERION_PERSONA` / `KYBERION_SUDO` /
  `MISSION_ID` blanked, `KYBERION_TENANT`, and `KYBERION_ROOT` when set — never
  `SYSTEM_ROLE`. The facade assumes its own narrow tenant-bound roles.
- An unexpected facade failure answers `unavailable` to the customer; the room
  logs the facade's `diagnostic_code` (a reason code, never the token) as a
  warning, and the facade records it in the audit chain.
- The token is read from the `Authorization` header only (a query-string token is
  ignored), is never logged or echoed, and is cleared from the address bar by
  the page (`history.replaceState`) right after it is read.
- Facade reason codes map to HTTP statuses (`invalid_link` 404, `expired`/`revoked`/`closed` 410,
  `updating`/`stale_version` 409, `invalid_answers` 422, `not_entitled` 403, anything else 503).
  The page shows plain messages, never codes or ids.
- `attachment` (CD-10) answers the image bytes of one id listed on the invite's
  agenda: the type comes from a fixed list (png / jpeg / webp) and must match the
  leading bytes, at most 512 KB, `X-Content-Type-Options: nosniff`,
  `Content-Disposition: inline`, `Cache-Control: no-store`. Anything else answers
  like `view` (`invalid_link` 404 for an id not on the agenda). The page fetches
  each image with the token header and shows it from a `blob:` URL (the CSP allows
  `blob:` for `img-src` only); external links open with `rel="noopener noreferrer"`.
- No operator `ViewerContext`, no other Kyberion API, no proxying. 64 KB body limit,
  per-client rate limit (the socket address, or the forwarded client address from a
  listed proxy; images have their own per-client budget, 120/min, and at most 4
  facade runs in flight, so an agenda with many images does not use up the
  view/respond budget; a full address table refuses new addresses rather than
  evicting a limited one), strict CSP (no inline script), `Referrer-Policy: no-referrer`,
  `Cache-Control: no-store`, `X-Frame-Options: DENY`.

## Language

All copy is the `customer_room` domain of
`knowledge/product/orchestration/user-facing-vocabulary.json` (en + ja, plus the
generated `qps-ploc`). The server embeds both bundles in the page as an inert
JSON block; the page uses the agenda's `locale` once loaded and the browser
language before that. Agenda content (questions, options) is already localized
by the agenda itself.

## Layout

```
server.ts                 entry (loopback, tenant gate, process guards)
src/server/routes.ts      the route table, headers, limits, reason mapping
src/server/facade.ts      the child-process door to customer_decision.js
src/server/page.ts        page template + vocabulary embedding
src/app/model.ts          fragment, drafts -> answers, wording, failure screens (no DOM)
src/app/api.ts            the calls (token in the header only)
src/app/main.ts           the page
static/                   index.html, app.css, generated kyberion-ui(.tokens).css
```

The two generated stylesheets come from `pnpm generate:design-tokens` like the
other surfaces; do not edit them.
