# TASK_BOARD: Browser Skill Surgical Refit Phase 3 (M-BROWSER-SURGERY-003)

## Vision Context
- Tenant: default
- Vision: /vision/_default.md (Logic first, Vision for tie-breaking)

## Status: Completed (Execution Phase)

- [x] **Step 1: Network & Stability (Wait Until Idle)**
  - [x] Implemented `wait_until_idle` using `page.waitForLoadState('networkidle')`.
- [x] **Step 2: Advanced Interaction (Drag & Drop / Scroll)**
  - [x] Implemented `drag_and_drop` from source to target locator.
  - [x] Implemented `scroll` action with distance or target.
- [x] **Step 3: Shadow DOM Awareness**
  - [x] Verified locators penetrate Shadow DOM naturally via Playwright's engine.
- [x] **Step 4: Human-in-the-Loop (Ask Human)**
  - [x] Implemented `ask_human` action to pause and wait for user confirmation.
  - [x] Added `--headful` CLI flag to support interactive sessions.
- [x] **Step 5: Final Validation**
  - [x] Verified all new actions with custom HTML reproduction cases.

## Victory Conditions
- [x] Engine can handle asynchronous data loads reliably.
- [x] Engine can perform drag & drop and explicit scrolls.
- [x] Engine can pause for human intervention (MFA/Captcha) and resume.
- [x] 100% of "complex" scenarios pass.
