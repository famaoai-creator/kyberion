---
title: Email operator path / メールオペレータ導線
tags: [email, operator-ux, gmail, email-actuator]
last_updated: 2026-09-06
---

# Email operator path / メールオペレータ導線

Operator face for inbox and send is **`pnpm kyberion email`**. Do not start from `email-actuator` when the job is "read the inbox".

オペレータの入口は **`pnpm kyberion email`**。受信トレイを読む仕事で `email-actuator` から始めない。

## Split / 役割分担

| Job / 仕事                  | Path / 経路                                                                    | Notes                                                                                              |
| --------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Inbox / triage (read)       | `pnpm kyberion email status` · `draft` · template `email-triage-workflow.json` | Google Workspace `gmail_triage` (`service:preset` `google-workspace`). Gmail/gws is the read path. |
| Latest draft                | `pnpm kyberion email latest-draft`                                             | Reads the stored draft artifact only.                                                              |
| Send / create draft (write) | `pnpm kyberion email deliver`                                                  | Approval-gated. `email-actuator` (`create_draft`, `send`, `send_from_file`) is delivery-oriented.  |
| Archive filters             | `pnpm kyberion email archive-inbox`                                            | Write-gated; use `--apply` only after review.                                                      |

## Commands

```bash
pnpm kyberion email --help
pnpm kyberion email status
pnpm kyberion email draft --triage-file active/shared/tmp/email-inbox-triage.md
pnpm kyberion email latest-draft
pnpm kyberion email deliver --draft-mode --body-file active/shared/runtime/presence-studio/email-drafts/latest.md
pnpm kyberion email deliver --approved --body-file active/shared/runtime/presence-studio/email-drafts/latest.md
```

Compat alias (same script, not the operator face): `pnpm email:workflow -- <command>`.

互換エイリアス(同じスクリプト。オペレータ面ではない): `pnpm email:workflow -- <command>`。

## What not to do / やらないこと

- Do not call `email-actuator` to list or triage mail. It has no receive ops.
- `email-actuator` で受信一覧やトリアージをしない。受信 op は無い。
- Do not treat Gmail/gws capture as a send path. Sending stays on `deliver` / `email-actuator` behind approval.
- Gmail/gws の読み取りを送信経路にしない。送信は承認付きの `deliver` / `email-actuator`。
