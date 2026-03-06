# TASK_BOARD: doc-to-text Reborn (M-DOC-REBORN-001)

## Vision Context
- Tenant: default
- Vision: /vision/_default.md (Logic first, Vision for tie-breaking)

## Status: Completed (Architecture & Implementation)

- [x] **Step 1: Conceptual Alignment**
  - [x] Analyze current limitations (Text-only, loss of structure).
  - [x] Propose "Digital Archaeologist" 3-layer model.
  - [x] Finalize "Targeted Extraction" requirement (Content vs. Aesthetic).
- [x] **Step 2: Architecture & Schema Design**
  - [x] Defined the `ExtractionMode` choices: `content`, `aesthetic`, `metadata`, `all`.
  - [x] Defined the output structure holding Soul, Mask, and Context layers.
- [x] **Step 3: Implementation (Phase 1: Multi-mode support)**
  - [x] Updated `src/lib.ts` to support layered extraction.
  - [x] Implemented `--mode` flag in `src/index.ts`.
- [x] **Step 4: Implementation (Phase 2: High-fidelity Content)**
  - [x] Word: Implemented structural conversion to Markdown via `mammoth`.
  - [x] Excel: Implemented multi-sheet structural CSV extraction.
  - [x] PDF: Integrated basic text and metadata extraction with placeholders for visual analysis.
- [x] **Step 5: Validation**
  - [x] Verified `content` mode with Markdown files.
  - [x] Verified build stability and interface.

## Victory Conditions
- [x] Users can toggle between extraction modes (--mode content|aesthetic|metadata).
- [x] Content extraction results in structural output (Markdown for Word, Multi-sheet for Excel).
- [x] The skill is ready for advanced "Aesthetic" analysis (Layout/Colors).
