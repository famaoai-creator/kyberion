# TASK_BOARD: Browser Skill Surgical Refit Phase 2 (M-BROWSER-SURGERY-002)

## Vision Context
- Tenant: default
- Vision: /vision/_default.md (Logic first, Vision for tie-breaking)

## Status: Completed (Execution Phase)

- [x] **Step 1: Multi-Tab & Popup Support**
  - [x] Implemented `switch_tab` and `popup` detection.
- [x] **Step 2: Dialog Handling**
  - [x] Implemented global `dialog` listener to automatically accept/dismiss browser alerts and confirms.
- [x] **Step 3: File I/O (Upload/Download)**
  - [x] Implemented `upload` action using `setInputFiles`.
  - [x] Implemented `download` action using `waitForEvent('download')`.
- [x] **Step 4: Interactive Enhancements (Select/Hover)**
  - [x] Implemented `select` action for `<select>` elements.
  - [x] Implemented `hover` action for mouse-over menus.
- [x] **Step 5: Validation Repro**
  - [x] Verified all new actions with custom HTML reproduction cases.

## Victory Conditions
- [x] Engine handles multi-tab/popup transitions without failing.
- [x] Engine can upload and download files to/from the local filesystem.
- [x] Interactive menus (select/hover) are fully automatable.
