---
category: Added
---

- **Conversation Engine now owns voice turn-taking** — the realtime voice loop feeds observations into the ConversationEngine and consumes its actions instead of running duplicated barge-in / EOT-hold / respond-gate / speculation deciders. All `--barge-in-mode` behaviors (off / legacy / two_stage) and the §13 contract are preserved.
- **Instant reaction slot + semantic reply segments** — `--instant-reaction` (bundled into `--conversation-engine`) plays a CE-supplied acknowledgement immediately on commit while reasoning streams the claim/explanation behind it; `assistant_text_delta` media events carry `reaction | claim | explanation | next` segment labels.
