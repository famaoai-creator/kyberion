---
title: Browser control playbook (interactive extension control)
tags: [browser, extension, control, cli, approvals]
last_updated: 2026-11-22
---

# Browser control playbook

`pnpm kyberion browser control` drives the operator's logged-in Chrome through
the extension bridge — interactive, stepwise control without recording a
procedure first. It is the governed counterpart to the replay path: same
op vocabulary, same ref resolution, different consent object.

## Consent model

| Layer            | What enforces it                                                                                                                                                                                                |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session approval | `open` creates an approval request; the session (`BCS-*`) is minted only after `pnpm kyberion approvals --approve <id>`                                                                                         |
| Origin binding   | Session pins one canonical origin; host re-checks on enqueue, extension re-checks before executing — navigation outside the origin fails the step                                                               |
| Risk ceiling     | `low` (default) admits the interactive vocabulary; `observe` admits reads only                                                                                                                                  |
| High-risk steps  | `submit_form`, `credential_submit`, `settings_change`, `delete`, `purchase`, `upload_file`, `download_file` need a per-step approval each — `browser control resume <approval_id>` runs the exact approved step |
| Expiry           | Sessions live ≤ 60 min (default 30); `close` revokes                                                                                                                                                            |

The session **is** the consent: steps never ask in the side panel and never
carry arbitrary JavaScript — the mailbox schema pins `step.op` to a fixed
vocabulary.

## Commands

```bash
pnpm kyberion browser control open https://example.com --label "task name"
pnpm kyberion browser control sessions
pnpm kyberion browser control tabs                 # list Chrome tabs
pnpm kyberion browser control tab <id>             # bind an already-open tab
pnpm kyberion browser control navigate <url>       # same-origin only
pnpm kyberion browser control snapshot             # fresh DOM refs (e1, e2, …)
pnpm kyberion browser control click <ref>
pnpm kyberion browser control fill <ref> <value>
pnpm kyberion browser control select <ref> --text <label> | --checked
pnpm kyberion browser control press <ref> [--key Enter]
pnpm kyberion browser control wait <ref>
pnpm kyberion browser control extract <ref> [--secret <name>]
pnpm kyberion browser control screenshot           # JPEG → artifact file
pnpm kyberion browser control download <ref>       # link/media → artifact file
pnpm kyberion browser control upload <ref> --file <path>
pnpm kyberion browser control submit|delete|purchase <ref>
pnpm kyberion browser control settings-change|credential-submit <ref>
pnpm kyberion browser control resume <approval_id> # after approving a step
pnpm kyberion browser control close [<session>]
```

`screenshot` and `download` return an `artifacts[]` entry — the bytes land in
`active/shared/runtime/browser-control/artifacts/<request_id>/` (same
retention entry as the secrets side-channel) and the response carries only
`{name, path, mime, bytes}` because the mailbox caps responses at 64 KiB.
Downloads cap at ~650 KB, uploads at ~1 MB (transport limits, not policy).

`--session <BCS-…>` picks a session when several are active; otherwise the
most recent active session is used. `--json` prints the raw response.
`--mission <id>` attaches a mission for audit.

## Working pattern

1. `open` the origin (or `tab <id>` to bind an existing logged-in tab).
2. `snapshot` → read `elements[]` for `ref`/`role`/`name`, `text` for content.
3. Act: `click`, `fill`, `press` … then `snapshot` again — refs are always
   resolved against the current DOM, so re-observe after every action.
4. `extract <ref> --secret <name>` for token-shaped values: the text moves to
   `active/shared/runtime/browser-control/secrets/<request>.json` (deleted on
   read) and the response keeps only the capture names. Feed it to
   `pnpm kyberion secret introduce --from-file` — never paste tokens in chat.
5. `close` the session when done (it also dies on TTL).

## Promoting a session to a procedure

Interactive work is journaled, so a session that succeeded can become a
replayable procedure — same review gate as side-panel recordings:

```bash
pnpm kyberion browser control export <BCS-…> [--title <t>]   # journal → BCR-… (pending)
pnpm kyberion browser control recordings                     # list exported recordings
pnpm kyberion browser control recordings show <BCR-…>        # inspect one
pnpm kyberion browser control review <BCR-…> --approve-all   # or --approve/--reject <ids>
pnpm kyberion browser control promote <BCS-…>                # export + governed promote
pnpm kyberion browser control promote --recording <BCR-…> [--id <procedure_id>] [--intent a,b]
```

`export` preserves op, target ref/role/name, risk, navigation transitions and
variables; the recording lands under the allowlisted recordings store with
`review.status=pending`. `promote` derives a safe `procedure_id` and intent
phrases from the session metadata, then calls the existing `promote-procedure`
pipeline — the candidate still needs an approved review before it reaches the
ProcedureCatalog and Pattern B replay.

## Vocabulary map

Three layers share the browser surface — same targets, different verbs:

| Layer                  | Opens a tab                                    | Reads the page                             | Acts                                                                                                                                                      | File in/out                   |
| ---------------------- | ---------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| CLI verb               | `open` / `navigate` / `tab`                    | `snapshot` `screenshot` `extract`          | `click` `fill` `select` `press` `submit` `delete` `purchase` `settings-change` `credential-submit`                                                        | `download` `upload`           |
| Control `step.op`      | `open_tab` `navigate` `select_tab` `list_tabs` | `snapshot` `screenshot` `extract_text_ref` | `click_ref` `click_if_present` `fill_ref` `select_ref` `press_ref` `wait_for_ref` `submit_form` `delete` `purchase` `settings_change` `credential_submit` | `download_file` `upload_file` |
| Mailbox `request_kind` | —                                              | `observe_tab` (panel-approved)             | `control_step`                                                                                                                                            | —                             |

ADF replay (`pnpm kyberion browser run`) is a different surface: it replays a
recorded procedure (`goto`/`click`/`fill` in `replay_steps`) against its own
runtime, not the live operator tab.

## Limits

- Single-operator channel: one allowlisted extension, one bound tab per
  session. Not a remote-control surface for other principals.
- `fill <ref> <value>` persists the value in the mailbox record — do not
  pass credentials as `value`; ask the operator to type them, or use an
  approved `credential_submit` step where the human completes the form.
- Page-touching ops (snapshot, clicks, fills, extract) need the per-origin
  extension grant: connect the tab once in the side panel ("このタブを接続")
  or the step fails with a permission hint. `tabs`/`tab`/`navigate` work
  without it.
- Mailbox delivery is hinted, not polled: the extension holds a persistent
  native port and the host pushes `mailbox_hint` when request files change
  (~1-2 s pickup, first step included). If the push channel is down the alarm
  poll (~1/min) plus a 5-minute fast-poll window after control_step activity
  still guarantee delivery.
- Sessions and the secrets side-channel are checkout-local — a step queued
  here is answered by the extension bound to this checkout's native host.

## Evidence

Every transition lands in
`active/shared/runtime/browser-control/sessions/<id>.journal.jsonl`
(session.minted / step.enqueued / step.approved / step.completed|failed /
step.denied.*), plus the mailbox audit events (`browser:bridge:enqueue:*`,
`browser:bridge:respond:*`).
