---
record_id: mem-MSN-CHROME-BRIDGE-BIDI-20261031-2026_10_30
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-CHROME-BRIDGE-BIDI-20261031-2026_10_30
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-30T19:27:15.291Z
source_branch: feat/chrome-bridge-bidirectional-20261031
source_commit: c628ce662b3b3556e863aa4adf486cfa2b7d1cf8
---

# MV3 extension bridges: keep page-dependent waits out of shared locks

Lessons from the Chrome Browser Bridge bidirectional mailbox: hostile pages can stall any await that needs their main thread, Built-in AI create() signals destroy the created object, and extension message handlers must check the sender.

## Hint Scope

mission

## Trigger Phrases

- Applies to: Chrome MV3 extensions (service worker + side panel + content scripts) that serialize state with a promise lock and talk to Kyberion via Native Messaging.

1. Never await a page-dependent call (tabs.sendMessage, scripting.executeScript in ISOLATED or MAIN world, content-script injection pings) while holding a lock that other handlers need. A page with an open alert()/confirm() or a busy main thread never settles these calls. Pattern: check the item under a short lock, release, do all page interaction under one overall timeout, then re-take the lock and re-check the item is still open before answering.
2. MAIN-world probes of page globals (e.g. WebMCP navigator.modelContextTesting.listTools) must race a timeout on both sides, read only own data properties via getOwnPropertyDescriptor (never getters), cap list walking, and never invoke page tools.
3. Chrome Built-in AI: an AbortSignal passed to LanguageModel/Summarizer/Translator create() destroys the created object when aborted later. Do not pass a caller signal to a shared base session; pass it to clone()/prompt() instead. Without clone(), hand the base to one caller only.
4. Accept privileged runtime messages and ports only from the side panel: !sender.tab and sender.url === chrome.runtime.getURL("sidepanel.html") (optionally ?/#). A userAction boolean in the message is not consent by itself.
5. Pull mailboxes over Native Messaging: redact after validating raw lengths and clamp after redaction; require allowed_origins for any tenant-scoped page read; classify CLI input files by written and real path and re-check after reading.

Evidence: independent review needed three rounds; round 2 found the lock stall still reachable through content-script injection after the probe itself was time-limited.

## Recommended References

- active/missions/public/MSN-CHROME-BRIDGE-BIDI-20261031/evidence/distillation.md
- active/missions/public/MSN-CHROME-BRIDGE-BIDI-20261031/evidence/REVIEW-execution-implement.md

## Evidence

- active/missions/public/MSN-CHROME-BRIDGE-BIDI-20261031/evidence/distillation.md
- active/missions/public/MSN-CHROME-BRIDGE-BIDI-20261031/evidence/REVIEW-execution-implement.md

## Artifacts
