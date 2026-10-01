# Commands Guide

Task-oriented notes for the everyday `pnpm kyberion <command>` commands. The full, generated list of every command and script is the [CLI Reference](../CLI_REFERENCE.md); first-time setup is in [QUICKSTART](../QUICKSTART.md). Any command accepts `--help` and prints its usage without side effects.

Most commands print readable text and accept `--json` for scripting. Paths you pass must live inside the repository; scratch files belong under `active/shared/tmp/<job>/`.

## Ask, decide and stay informed

### `ask`

Say what you want in plain words. Kyberion resolves the intent, then explains, clarifies, or runs it through the governed route (approval gates still apply).

```bash
pnpm kyberion ask "summarize this week's meeting minutes"
pnpm kyberion ask --explain "book a room for Friday"   # show how the request was interpreted first
```

### `inbox`

Deliverables Kyberion produced for you. With no flag it lists the latest 30 entries (`●` unread, `○` read, `✔` accepted).

```bash
pnpm kyberion inbox                      # list
pnpm kyberion inbox --read <entry-id>    # mark as read
pnpm kyberion inbox --accept <entry-id>  # accept (records that you take responsibility for its use)
pnpm kyberion inbox --read-all [--match <text>]
```

### `notify`

Show or set where Kyberion notifies you by default.

```bash
pnpm kyberion notify                      # print the current preferences (JSON)
pnpm kyberion notify --set slack:<target> # surface:target; surfaces: slack, imessage, telegram, discord, inbox
pnpm kyberion notify --set inbox          # local fallback, no bridge needed
```

### `memory`

Working memory for notes that outlive a session.

```bash
pnpm kyberion memory capture --content "Prefer morning meetings" [--section <name>]
pnpm kyberion memory list [--scope <scope>] [--status <status>]
pnpm kyberion memory read --path <active-path>
pnpm kyberion memory promote --path <active-path> --summary "<why this is durable>"
```

`capture` writes to the personal tier by default; `promote` only nominates a note for promotion, it does not publish it.

## Calendar

`calendar` talks to Google Workspace (default) or Microsoft 365 (`--provider m365`). Check readiness first.

```bash
pnpm kyberion calendar status
pnpm kyberion calendar list-calendars
pnpm kyberion calendar agenda --calendar-id primary --days 7
pnpm kyberion calendar freebusy --calendar-ids primary,team@example.com \
  --time-min 2026-06-21T09:00:00+09:00 --time-max 2026-06-21T18:00:00+09:00
pnpm kyberion calendar create-event --summary "Planning" \
  --start 2026-06-22T13:00:00+09:00 --end 2026-06-22T14:00:00+09:00 [--with-meet] [--attendees a@x.com,b@x.com]
```

`freebusy` requires `--time-min` and `--time-max`; `create-event` requires `--summary`, `--start`, `--end` (add `--dry-run` to preview). Missing auth shows up in `calendar status` — fix it with `pnpm kyberion setup` and [OAUTH_SETUP](../OAUTH_SETUP.md).

## Schedule a pipeline

```bash
pnpm kyberion schedule list
pnpm kyberion schedule register <id> <pipeline-path> <actuator> "<cron>"
pnpm kyberion schedule remove <id>
```

`register` stores a cron-triggered entry for a pipeline file (for example `pipelines/daily-routine.json`); `remove` deletes it by id.

## See the world: capture and record

| Command                                                  | Result                                                                                                                             |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `capture [--screen\|--window\|--camera] [--out <image>]` | A still image (screen by default; screen captures are redacted). Read it back with `pnpm kyberion see <image>`.                    |
| `record screen [--duration <s>]`                         | Screen video (mp4/mov, frames redacted, max 300 s).                                                                                |
| `record audio [--duration <s>] [--device <name>]`        | Microphone audio (wav/mp3/m4a, max 300 s). For meetings use `pnpm minutes:record`. Transcribe with `pnpm kyberion listen <audio>`. |
| `record camera [--duration <s>]`                         | Camera video (low fps, max 60 s).                                                                                                  |

Default duration is 5 seconds; outputs land in the governed store unless `--out` points inside the repository. `record desktop` (a different command) records a desktop procedure for later promotion — see `pnpm kyberion recording`.

## Documents: write and diff

```bash
pnpm kyberion write <brief.json> --out <file> [--to pptx|docx|xlsx|pdf] [--profile <id>]
pnpm kyberion diff <a> <b> [--json]
```

`write` turns a semantic brief (content and intent only) into a document; theme and layout come from the design layer, so the brief carries no styles. The target format follows `--to`, then the brief's `render_target`, then the `--out` extension. Brief shape: `knowledge/product/schemas/document-brief.schema.json`. `diff` compares two files of the same format (for example a source and its round-trip) and lists the design fields that differ. `pnpm kyberion read <file>` is the inverse of `write`.

## Find and inspect

| Command                                      | Use it to                                                                                    |
| -------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `search <keyword>`                           | Find actuators by keyword.                                                                   |
| `info <actuator>`                            | Show one actuator's description and ops (`pnpm kyberion list` shows all).                    |
| `mobile-profiles [id]` / `web-profiles [id]` | List the shared app profiles, or show one in detail.                                         |
| `artifact <path>`                            | Show metadata of a generated artifact (for example a deck under `active/shared/tmp/media/`). |
| `open-artifact <path>`                       | Open that artifact in the OS viewer.                                                         |

## Browser profiles

```bash
pnpm kyberion browser profiles [--provider chrome|playwright|all] [--json]
pnpm kyberion browser create <name> [--engine chromium|firefox|webkit] [--email <address>]
pnpm kyberion browser open <url> [--profile <name|id|email>] [--provider chrome|playwright]
```

`create` makes an isolated Playwright profile; `open` launches a visible browser with the chosen profile (the first available one if you give none).

## Mount outside data: vault

`vault` exposes a host file or directory to agents read-only, through a governed symlink under `vault/mounts/`.

```bash
pnpm kyberion vault mount <source-path> [name]
pnpm kyberion vault list
pnpm kyberion vault unmount <name>
pnpm kyberion vault cleanup      # remove broken mounts
```

## Workspaces

```bash
pnpm kyberion workspace list           # registered workspaces and unregistered directories
pnpm kyberion workspace gc             # dry run: report orphaned workspaces
pnpm kyberion workspace gc --apply     # delete orphaned, ledger-registered workspaces
```

`gc` only ever deletes workspaces the ledger registered, never arbitrary directories.

## Secrets

The secret value is never passed on the command line. It comes from a hidden prompt, or from `--from-file` under `active/shared/tmp/`.

```bash
pnpm kyberion secret introduce <serviceId> <secretKey> [--from-file <path>] [--reason "<why>"]
pnpm kyberion secret status <serviceId>          # which required secrets are present or missing
pnpm kyberion secret apply <approvalId> [--from-file <path>]
```

`introduce` opens an approval request and, when approved locally, stores the value. If approval is still pending it prints the next steps: `pnpm kyberion approve <id>`, then `secret apply`.

## Install a skill bundle

```bash
pnpm kyberion skill install            # list bundles and choose one interactively
pnpm kyberion skill install <bundle-id>
```

It checks the bundle's required capabilities and offers to install missing system dependencies (Homebrew or pip), asking before it installs anything. Plugin packages are separate: `pnpm plugin:install`.

## Choose a provider for a capability: seam select

Some capabilities (OCR, transcription, and so on) can be served by several providers. `seam select` shows how Kyberion picks one and lets you set your own preference.

```bash
pnpm kyberion seam select list
pnpm kyberion seam select explain --seam ocr-provider --purpose accuracy
pnpm kyberion seam select rules list
pnpm kyberion seam select rules set --seam <seam> --rule-id <id> --prefer providerA,providerB
pnpm kyberion seam select rules remove --rule-id <id>
pnpm kyberion seam select calibrate --seam <seam> --input input.json
```

Rules are stored in the operator overlay `active/shared/runtime/seam-selection/rules.json`, and every change is audited.

## Working next to another agent: co-session

When several provider CLIs (`claude`, `codex`, `agy`, ...) work in the same checkout, `co-session` coordinates them without a mission: a shared goal, presence, path leases so two agents do not edit the same files, and handoffs.

```bash
pnpm kyberion co-session start --goal "<goal>" --as <provider>
pnpm kyberion co-session join --as <provider>
pnpm kyberion co-session lease --action acquire --as <provider> --path <path>
pnpm kyberion co-session status
pnpm kyberion co-session close --as <provider>
```

Also available: `heartbeat`, `leave`, `blackboard`, `handoff`, `promote-hint`. Design: [co-session-coordination](../../knowledge/product/architecture/co-session-coordination.md).

## Related

- [QUICKSTART](../QUICKSTART.md), [TROUBLESHOOTING](./TROUBLESHOOTING.md), [OPERATOR_UX_GUIDE](../OPERATOR_UX_GUIDE.md)
- Perception verbs `read`, `see`, `listen`, `watch`, `speak`, `draw`: [user README](./README.md#one-command-per-sense)
