---
title: Google Drive Ingest & Storage Adapter Model
category: Architecture
tags: [architecture, ingest, storage, google-drive, seam-provider, actuators]
importance: 8
author: Ecosystem Architect
last_updated: 2026-09-24
---

# Google Drive Ingest & Storage Adapter Model

## 1. Goal

Integrate Google Drive into Kyberion's governed data ingestion (`ingest-actuator`) and shared file transport seams. This provides:

1. Enterprise/Personal knowledge ingestion from Google Drive docs/sheets/slides into governed knowledge cards.
2. An asynchronous, non-blocking I/O bridge between Kyberion and remote compute substrates such as Google Colab.

## 2. Architectural Placement

Google Drive participates in two Kyberion subsystems:

```text
[ Kyberion Core ]
       │
       ├───> [ ingest-actuator: sync_source ] ───> `google_drive` source provider
       │       - Tracks file changes via Drive Changes API / Watermarks
       │       - Dispatches to parse_document (gdoc, gsheet, pdf, docx)
       │
       └───> [ Storage / Transport Seam ] ───────> `google_drive` storage adapter
               - Bidirectional job file transfer for `compute-actuator` (Colab)
               - Respects tenant root isolation & token boundaries
```

## 3. Ingest Source Protocol: `google_drive`

Adding `google_drive` as a recognized `SyncSourceSystem` alongside `box`, `slack`, and `confluence` in `libs/actuators/ingest-actuator/src/sync-source.ts`:

- **Incremental Change Detection (Watermark)**:
  - Uses Google Drive `startPageToken` / `savedChangeToken` as the durable cursor.
  - Stored in `active/shared/runtime/ingest-cursors/` scoped per `tenant × google_drive`.
- **Parsing**:
  - Google Docs / Sheets / Slides are exported to standard intermediate formats (PDF, Markdown, XLSX) and parsed via existing `parseDocument` transforms.
- **Deduplication & Asset Ledger**:
  - Integrates with `ingest:dedup` and `ingest:commit` ceremonies to maintain immutable provenance and supersede chains.
