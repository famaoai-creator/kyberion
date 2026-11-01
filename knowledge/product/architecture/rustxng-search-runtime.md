---
title: RustXNG as a Local Search Runtime — Integration
kind: reference
scope: repository
authority: reference
phase: [alignment, execution]
tags: [search, actuator, rustxng, tool-runtime, service-runtime, agpl]
owner: ecosystem_architect
last_updated: 2026-11-02
---

# RustXNG as a Local Search Runtime — Integration

[RustXNG](https://github.com/sahenjp/RustXNG) is a SearXNG-compatible,
self-hosted search and grounding engine written in Rust (AGPL-3.0-or-later).
It exposes a local HTTP API that returns ranked results plus optional page
text (`include_raw_content`), with SSRF guards on outbound fetches.

## Licence boundary

Upstream `NOTICE` states that spawning the binary or talking to its HTTP API
on `127.0.0.1` keeps the caller under its own licence (same pattern as
rustdsh / MIT). Kyberion is MIT: **invoke RustXNG as an external process /
HTTP peer — never vendor or link it.** Modified network-facing instances
must still satisfy AGPL §13 source offer.

## Install

Governed tool-runtime `rustxng` (checksum-pinned `managed_binary`, 0.26.0):

```bash
pnpm tool:setup -- --tool rustxng --apply
# → active/shared/runtime/tool-runtimes/rustxng/bin/rustxng
```

Resolve the binary with `resolveRustxngBin()` (`KYBERION_RUSTXNG_BIN`
override first). Platforms with release assets: darwin arm64/x64, linux x64
(gnu), win32 x64. **linux-arm64 is not published in v0.26.0.**

## Run

Manual:

```bash
rustxng   # default http://127.0.0.1:8888
# optional sidecar idle exit: RUSTXNG_IDLE_TIMEOUT=300 rustxng
```

Service-runtime `rustxng` probes `GET /healthz`. Override the base URL with
`KYBERION_RUSTXNG_URL`.

## web-search-runtime seam

RustXNG is one provider on the `web-search-runtime` seam
(`libs/core/search/web-search-runtime-bridge.ts`). The search-actuator resolves
`params.provider` through that seam — it does not hard-code engine branches.

| Provider  | Role                                                           |
| --------- | -------------------------------------------------------------- |
| `stub`    | Offline-safe default for `auto` / omitted provider             |
| `rustxng` | Opt-in local engine (`capabilities` set → never auto-selected) |

Selection policy: `knowledge/product/governance/seam-provider-selection/web-search-runtime.json`.

Opt-in call:

```json
{ "op": "web_search", "params": { "query": "tokio runtime", "provider": "rustxng", "top_k": 5 } }
```

The RustXNG adapter calls `/search?format=json&include_raw_content=1&max_results=<top_k>`
and maps `title` / `url` / `content` / `raw_content`.

### Loopback sidecar auto-start

When `provider=rustxng` and `/healthz` is down on a loopback URL, the client
spawns a **detached** managed binary (`safeSpawn`, `unref`) with
`RUSTXNG_IDLE_TIMEOUT` (from `KYBERION_RUSTXNG_IDLE_TIMEOUT`, default 300) so
the process survives the calling shell and exits after idle — same shape as
rdsh's sidecar. Concurrent starts coalesce on one in-flight promise.

- Disable: `KYBERION_RUSTXNG_AUTOSTART=0`
- Non-loopback `KYBERION_RUSTXNG_URL` never auto-starts (fail closed with a
  reachability error)

## Fit

- Good: keyless local grounding for research workers; SearXNG-compatible JSON;
  repeated queries benefit from RustXNG's response cache.
- Caveats: queries still leave the machine toward upstream engines; Google is
  effectively unavailable upstream; engine suspension can degrade quality while
  `/healthz` stays green.
