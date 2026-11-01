---
category: Added
---

- **web-search-runtime seam + RustXNG provider** — `search-actuator` dispatches `web_search` through a named seam (`stub` for `auto`, opt-in providers by id). RustXNG registers as a checksum-pinned managed tool / service runtime and as the first service-backed provider (`provider=rustxng`); loopback auto-starts a detached sidecar when `/healthz` is down (`KYBERION_RUSTXNG_IDLE_TIMEOUT`, default 300s; `KYBERION_RUSTXNG_AUTOSTART=0` to disable). External process / HTTP only (AGPL never vendored).
