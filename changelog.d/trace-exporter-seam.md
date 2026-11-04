---
category: Added
---

- Add a governed fan-out `trace-exporter` provider seam (`libs/core/analysis/trace-exporter.ts`): `persistTrace` keeps the local JSONL authoritative and then hands the sanitized trace to every enabled exporter in governed order (`seam-provider-selection/trace-exporter.json`). The existing OTLP/HTTP bridge becomes the builtin `otlp-http` provider (still opt-in via `OTEL_EXPORTER_OTLP_ENDPOINT`); vendor exporters (Datadog, CloudWatch, Sentry) register without editing `trace.ts`, and one exporter's failure never blocks the others.
