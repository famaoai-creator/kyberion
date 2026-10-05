# CLI Reference

<!-- GENERATED FILE — DO NOT EDIT BY HAND.
     Source: knowledge/product/governance/cli-commands.json + the `cli` namespace of
     knowledge/product/orchestration/user-facing-vocabulary.json.
     Regenerate: pnpm generate:cli-reference   Check: pnpm generate:cli-reference --check -->

Every governed `kyberion` command and `pnpm` script, generated from the command manifest. Run `pnpm kyberion --help` for the same list in your terminal, and `pnpm kyberion <command> --help` for one command. Task-oriented walk-throughs of the everyday commands are in the [Commands Guide](./user/COMMANDS_GUIDE.md); first-time setup is in [QUICKSTART](./QUICKSTART.md).

`pnpm kyberion <command>` and the matching `pnpm <script>` run the same target; use whichever you prefer.

## Everyday commands (user)

### Start

| Command                | pnpm script       | What it does                                               |
| ---------------------- | ----------------- | ---------------------------------------------------------- |
| `pnpm kyberion`        |                   | Home: status digest and next action                        |
| `pnpm kyberion ask`    |                   | Ask Kyberion in natural language                           |
| `pnpm kyberion doctor` | `pnpm run doctor` | Diagnose health and suggest the next action                |
| `pnpm kyberion help`   |                   | Show this command list                                     |
| `pnpm kyberion intent` |                   | Deprecated alias of ask (resolve free text into an intent) |

### Inspect

| Command                                 | pnpm script | What it does                                                  |
| --------------------------------------- | ----------- | ------------------------------------------------------------- |
| `pnpm kyberion artifact`                |             | Inspect a generated artifact                                  |
| `pnpm kyberion calendar agenda`         |             | Show upcoming agenda                                          |
| `pnpm kyberion calendar freebusy`       |             | Show free/busy slots                                          |
| `pnpm kyberion calendar list-calendars` |             | List available calendars                                      |
| `pnpm kyberion calendar status`         |             | Show calendar connection status                               |
| `pnpm kyberion deals`                   |             | List deals and inspect captured requirements                  |
| `pnpm kyberion diff`                    |             | Compare the design of two documents                           |
| `pnpm kyberion email latest-draft`      |             | Show the latest email draft                                   |
| `pnpm kyberion email status`            |             | Show email connection and workflow status                     |
| `pnpm kyberion examples`                |             | Show runnable actuator examples                               |
| `pnpm kyberion improvements`            |             | Review improvement candidates                                 |
| `pnpm kyberion inbox`                   |             | Review and accept deliverables in the inbox                   |
| `pnpm kyberion info`                    |             | Show details for one actuator                                 |
| `pnpm kyberion list`                    |             | List actuators (--check probes runtime capability)            |
| `pnpm kyberion listen`                  |             | Transcribe audio                                              |
| `pnpm kyberion memory`                  |             | Inspect or capture operator memory                            |
| `pnpm kyberion mobile-profiles`         |             | List or inspect shared mobile app profiles                    |
| `pnpm kyberion open-artifact`           |             | Open a generated artifact in the OS viewer                    |
| `pnpm kyberion preview`                 |             | Validate a pipeline JSON and show its step tree               |
| `pnpm kyberion read`                    |             | Read a document (pdf, pptx, docx, xlsx, html, md) as Markdown |
| `pnpm kyberion recording`               |             | Inspect the intent and steps reconstructed from a recording   |
| `pnpm kyberion schedule list`           |             | List scheduled pipelines                                      |
| `pnpm kyberion search`                  |             | Search actuators by keyword                                   |
| `pnpm kyberion see`                     |             | Describe an image                                             |
| `pnpm kyberion watch`                   |             | Summarize a video                                             |
| `pnpm kyberion web-profiles`            |             | List or inspect shared web app profiles                       |

### Operate

| Command                               | pnpm script           | What it does                                                 |
| ------------------------------------- | --------------------- | ------------------------------------------------------------ |
| `pnpm kyberion approvals`             |                       | Review and decide approval requests                          |
| `pnpm kyberion calendar`              |                       | Calendar workflow: status, agenda, free/busy, events         |
| `pnpm kyberion calendar create-event` |                       | Create a calendar event (approval-gated)                     |
| `pnpm kyberion capture`               |                       | Capture a still image of the screen, a window, or the camera |
| `pnpm kyberion draw`                  |                       | Generate an image                                            |
| `pnpm kyberion email`                 |                       | Email workflow: status, drafts, delivery, archive            |
| `pnpm kyberion email deliver`         |                       | Send an approved email draft                                 |
| `pnpm kyberion email draft`           |                       | Draft email replies from a triage file                       |
| `pnpm kyberion feedback`              |                       | Record feedback or a correction for a past intent            |
| `pnpm kyberion notify`                |                       | Inspect or configure notification targets                    |
| `pnpm kyberion procedure`             |                       | List, inspect, repair, promote, or run registered procedures |
| `pnpm kyberion record`                |                       | Record an OS demonstration with screen evidence              |
| `pnpm kyberion record audio`          |                       | Record audio                                                 |
| `pnpm kyberion record camera`         |                       | Record the camera                                            |
| `pnpm kyberion record screen`         |                       | Record the screen                                            |
| `pnpm kyberion schedule`              |                       | Manage scheduled pipelines                                   |
| `pnpm kyberion speak`                 |                       | Speak text aloud                                             |
| `pnpm kyberion work inventory`        | `pnpm work:inventory` | Manage the work inventory                                    |
| `pnpm kyberion write`                 |                       | Author a document from a semantic brief                      |

## Operator commands

### Start

| Command                            | pnpm script               | What it does                                                              |
| ---------------------------------- | ------------------------- | ------------------------------------------------------------------------- |
| `pnpm kyberion agy sdk-setup`      | `pnpm agy:sdk-setup`      | Set up the agy SDK                                                        |
| `pnpm kyberion env bootstrap`      | `pnpm env:bootstrap`      | Bootstrap the local environment                                           |
| `pnpm kyberion kyberion`           | `pnpm kyberion`           | The kyberion CLI itself                                                   |
| `pnpm kyberion onboarding`         | `pnpm onboarding`         | Run the onboarding wizard (identity, services, tenant)                    |
| `pnpm kyberion onboarding context` | `pnpm onboarding:context` | Resolve tenant and organization context for onboarding                    |
| `pnpm kyberion provider-cli setup` | `pnpm provider-cli:setup` | Install or inspect managed provider CLIs                                  |
| `pnpm kyberion reasoning setup`    | `pnpm reasoning:setup`    | Set up a reasoning backend                                                |
| `pnpm kyberion service setup`      | `pnpm service:setup`      | Set up external service connections                                       |
| `pnpm kyberion setup`              |                           | Set up one area (onboarding, reasoning, env, services, tools, voice, ...) |
| `pnpm kyberion setup report`       |                           | Report setup status and missing steps                                     |
| `pnpm kyberion tool setup`         | `pnpm tool:setup`         | Install or inspect tool runtimes                                          |
| `pnpm kyberion vital`              |                           | Check operator readiness (vital signs)                                    |
| `pnpm kyberion voice setup`        |                           | Check and set up voice readiness                                          |

### Inspect

| Command                                      | pnpm script                       | What it does                                                                                                                                   |
| -------------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm kyberion approvals digest`             |                                   | Summarize pending decisions and autonomous actions as a digest (optionally send it).                                                           |
| `pnpm kyberion audit verify`                 | `pnpm audit:verify`               | Verify the audit chain                                                                                                                         |
| `pnpm kyberion auth check`                   |                                   | Check reasoning backend authentication                                                                                                         |
| `pnpm kyberion automation blueprint`         | `pnpm automation:blueprint`       | Preview an automation blueprint                                                                                                                |
| `pnpm kyberion bindings`                     | `pnpm bindings`                   | Inspect the runtime seam catalog                                                                                                               |
| `pnpm kyberion browser inspect`              |                                   | Inspect a browser page                                                                                                                         |
| `pnpm kyberion browser profiles`             |                                   | List browser profiles                                                                                                                          |
| `pnpm kyberion capabilities`                 | `pnpm capabilities`               | Discover actuators without a build                                                                                                             |
| `pnpm kyberion channels list`                | `pnpm channels:list`              | List channels                                                                                                                                  |
| `pnpm kyberion config report`                | `pnpm config:report`              | Report operational configuration                                                                                                               |
| `pnpm kyberion conversation report`          |                                   | Report how the conversation is going: turn outcomes per intent, unanswered clarifications and repeated misses worth adding to the eval corpus. |
| `pnpm kyberion cost report`                  | `pnpm cost:report`                | Report usage cost                                                                                                                              |
| `pnpm kyberion dot autonomy`                 |                                   | Show a resident dot's graduated-autonomy level, metrics and shadow decisions                                                                   |
| `pnpm kyberion dot followups`                |                                   | List a resident dot's pending self-scheduled follow-ups                                                                                        |
| `pnpm kyberion dot kr`                       |                                   | Show a resident dot's latest key-result measurements and goal gaps                                                                             |
| `pnpm kyberion dot list`                     |                                   | List resident-agent (dot) charters and their status                                                                                            |
| `pnpm kyberion dot memory`                   |                                   | Show a resident dot's working memory (notes, open items, hypotheses)                                                                           |
| `pnpm kyberion dot outcomes`                 |                                   | Show the recorded outcome evaluations of a resident dot's actions                                                                              |
| `pnpm kyberion dot status`                   |                                   | Show wake/heartbeat/token status for dot charters                                                                                              |
| `pnpm kyberion dot validate`                 |                                   | Validate dot charters against schema and the activation gate                                                                                   |
| `pnpm kyberion dot work`                     |                                   | Show recent delegated-work results executed for a resident dot                                                                                 |
| `pnpm kyberion egress report`                | `pnpm egress:report`              | Report egress warnings                                                                                                                         |
| `pnpm kyberion halt status`                  |                                   | Show whether autonomous operations are halted, since when and by whom.                                                                         |
| `pnpm kyberion history search`               | `pnpm history:search`             | Search history                                                                                                                                 |
| `pnpm kyberion hooks discover`               |                                   | List project-local Claude/Codex hook configs and whether each is trusted.                                                                      |
| `pnpm kyberion ingress probe`                |                                   | Check which public ingress providers are ready                                                                                                 |
| `pnpm kyberion ingress status`               |                                   | Show surfaces exposed through public ingress                                                                                                   |
| `pnpm kyberion intent trace`                 | `pnpm intent:trace`               | Trace intent resolution                                                                                                                        |
| `pnpm kyberion knowledge rank`               |                                   | Rank knowledge for a context                                                                                                                   |
| `pnpm kyberion knowledge scope-health`       |                                   | Report tenant knowledge scope health                                                                                                           |
| `pnpm kyberion marketing review-aggregate`   |                                   | Aggregate review results for marketing content.                                                                                                |
| `pnpm kyberion meeting preflight`            | `pnpm meeting:preflight`          | Check meeting readiness                                                                                                                        |
| `pnpm kyberion memory promotion-queue`       |                                   | Summarize the memory promotion queue.                                                                                                          |
| `pnpm kyberion mesh-hub inspect`             | `pnpm mesh-hub:inspect`           | Inspect the Mesh Hub                                                                                                                           |
| `pnpm kyberion mission journal`              |                                   | Show the mission journal                                                                                                                       |
| `pnpm kyberion ops alerts`                   | `pnpm ops:alerts`                 | Triage undelivered alerts                                                                                                                      |
| `pnpm kyberion packet`                       |                                   | Render an operator packet or status report                                                                                                     |
| `pnpm kyberion pr shadow-report`             |                                   | Compare the gate's shadow verdicts on pull requests with what the operator actually did.                                                       |
| `pnpm kyberion project-trust`                |                                   | Show project trust requests                                                                                                                    |
| `pnpm kyberion provider-capabilities scan`   | `pnpm provider-capabilities:scan` | Scan provider CLI capabilities                                                                                                                 |
| `pnpm kyberion reasoning config`             | `pnpm reasoning:config`           | Show or change reasoning configuration                                                                                                         |
| `pnpm kyberion report team-decision-support` |                                   | Report how the roster proposer and advisory panel performed, from recorded outcomes.                                                           |
| `pnpm kyberion scope`                        | `pnpm scope`                      | Inspect the active scope                                                                                                                       |
| `pnpm kyberion secret status`                |                                   | Show secret status                                                                                                                             |
| `pnpm kyberion service preflight`            | `pnpm service:preflight`          | Check service readiness                                                                                                                        |
| `pnpm kyberion stance list`                  | `pnpm stance:list`                | List stance overlays                                                                                                                           |
| `pnpm kyberion task list`                    | `pnpm task:list`                  | List tasks                                                                                                                                     |
| `pnpm kyberion task plan`                    |                                   | Preview a task plan without executing it                                                                                                       |
| `pnpm kyberion task scenario`                |                                   | Show task scenario examples                                                                                                                    |
| `pnpm kyberion vault list`                   |                                   | List vault mounts                                                                                                                              |
| `pnpm kyberion voice conversation-config`    | `pnpm voice:conversation-config`  | Show realtime voice conversation config                                                                                                        |
| `pnpm kyberion voice route`                  | `pnpm voice:route`                | Show or set voice routing                                                                                                                      |
| `pnpm kyberion workspace list`               |                                   | List workspace ledger entries                                                                                                                  |

### Operate

| Command                                       | pnpm script                         | What it does                                                                                                          |
| --------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `pnpm kyberion a2a run`                       |                                     | Send an agent-to-agent (A2A) request and print the response.                                                          |
| `pnpm kyberion accept-next-action`            |                                     | Execute a suggested next action from a packet                                                                         |
| `pnpm kyberion action-items remind`           |                                     | Draft reminders for pending meeting action items across active missions.                                              |
| `pnpm kyberion agent-runtime daemon`          |                                     | Run the agent runtime supervisor daemon                                                                               |
| `pnpm kyberion agent-runtime manage`          |                                     | Inspect and control long-lived agent runtimes (list, start, stop).                                                    |
| `pnpm kyberion agent-runtime supervisor`      | `pnpm agent-runtime:supervisor`     | Run the agent runtime supervisor                                                                                      |
| `pnpm kyberion agents generate`               | `pnpm agents:generate`              | Regenerate provider subagent definitions                                                                              |
| `pnpm kyberion agy profile`                   |                                     | Manage agy profiles                                                                                                   |
| `pnpm kyberion ai-test`                       | `pnpm ai-test`                      | Run the AI audit test layer                                                                                           |
| `pnpm kyberion approvals hygiene`             |                                     | Expire stale pending approvals and move test-fixture records out of the store (dry-run by default).                   |
| `pnpm kyberion approve`                       |                                     | Approve a pending request                                                                                             |
| `pnpm kyberion audit mirror-reconcile`        |                                     | Reconcile customer audit mirrors against the master chain                                                             |
| `pnpm kyberion background-review`             | `pnpm background-review`            | Run background review maintenance                                                                                     |
| `pnpm kyberion background-review mission-e2e` |                                     | Run the background review mission E2E                                                                                 |
| `pnpm kyberion backup`                        | `pnpm backup`                       | Back up or export tenant data                                                                                         |
| `pnpm kyberion browser create`                |                                     | Create a browser profile                                                                                              |
| `pnpm kyberion browser open`                  |                                     | Open a browser profile                                                                                                |
| `pnpm kyberion browser run`                   |                                     | Run a browser procedure or ADF                                                                                        |
| `pnpm kyberion campaign suite`                |                                     | Run the campaign suite                                                                                                |
| `pnpm kyberion changelog assemble`            |                                     | Assemble changelog fragments                                                                                          |
| `pnpm kyberion chronos dev`                   | `pnpm chronos:dev`                  | Run the Chronos UI dev server                                                                                         |
| `pnpm kyberion clipboard-inbox server`        |                                     | Start the clipboard inbox pad                                                                                         |
| `pnpm kyberion co-session`                    |                                     | Coordinate same-checkout provider CLIs                                                                                |
| `pnpm kyberion codex profile`                 |                                     | Manage codex profiles                                                                                                 |
| `pnpm kyberion config-mission`                | `pnpm config-mission`               | Run a configuration mission                                                                                           |
| `pnpm kyberion control`                       | `pnpm control`                      | Control plane CLI                                                                                                     |
| `pnpm kyberion create actuator`               |                                     | Scaffold a new actuator                                                                                               |
| `pnpm kyberion daemon watchdog`               | `pnpm daemon:watchdog`              | Check long-lived daemons                                                                                              |
| `pnpm kyberion daily-desk server`             |                                     | Start the daily desk pad                                                                                              |
| `pnpm kyberion dashboard`                     | `pnpm dashboard`                    | Open the sovereign dashboard                                                                                          |
| `pnpm kyberion doc-drop server`               |                                     | Start the document drop pad                                                                                           |
| `pnpm kyberion dot activate`                  |                                     | Activate a dot charter after the role/heartbeat gate passes                                                           |
| `pnpm kyberion dot event`                     |                                     | Ingest a local test event into the dot event ledger (--source, --file)                                                |
| `pnpm kyberion dot inbox`                     |                                     | Append a wake-lane row to a resident dot's inbox                                                                      |
| `pnpm kyberion dot pause`                     |                                     | Pause an active dot (triggers stop firing)                                                                            |
| `pnpm kyberion dot release`                   |                                     | Request human approval to release a quarantined dot WorkItem after verifying its effects (--reason)                   |
| `pnpm kyberion dot retire`                    |                                     | Retire a dot charter permanently                                                                                      |
| `pnpm kyberion dot wake`                      |                                     | Run one bounded wake for a dot immediately                                                                            |
| `pnpm kyberion email archive-inbox`           |                                     | Archive processed inbox messages                                                                                      |
| `pnpm kyberion email workflow`                | `pnpm email:workflow`               | Run the email workflow                                                                                                |
| `pnpm kyberion generation schedule`           | `pnpm generation:schedule`          | Run the generation schedule tick                                                                                      |
| `pnpm kyberion gws meet-create`               |                                     | Create a Google Meet                                                                                                  |
| `pnpm kyberion halt engage`                   |                                     | Halt all autonomous operations (work claims, dot wakes, auto-proceed) until resumed.                                  |
| `pnpm kyberion halt resume`                   |                                     | Resume autonomous operations after a halt.                                                                            |
| `pnpm kyberion hooks trust`                   |                                     | Request human approval to trust one project hook config (bound to its content).                                       |
| `pnpm kyberion ingress down`                  |                                     | Withdraw a surface's public ingress                                                                                   |
| `pnpm kyberion ingress up`                    |                                     | Expose a surface at a public HTTPS URL (approval required)                                                            |
| `pnpm kyberion intent run`                    | `pnpm intent:run`                   | Dispatch a catalog intent as a task session                                                                           |
| `pnpm kyberion knowledge`                     | `pnpm knowledge`                    | Manage knowledge                                                                                                      |
| `pnpm kyberion knowledge cowork-sync`         | `pnpm knowledge:cowork-sync`        | Sync knowledge with Cowork                                                                                            |
| `pnpm kyberion knowledge feedback`            | `pnpm knowledge:feedback`           | Record knowledge feedback                                                                                             |
| `pnpm kyberion knowledge ingest`              | `pnpm knowledge:ingest`             | Ingest a file into tenant knowledge                                                                                   |
| `pnpm kyberion knowledge scope-reconcile`     | `pnpm knowledge:scope-reconcile`    | Reconcile tenant knowledge scopes                                                                                     |
| `pnpm kyberion knowledge sync`                | `pnpm knowledge:sync`               | Run the knowledge sync pipeline                                                                                       |
| `pnpm kyberion manifests sign`                | `pnpm manifests:sign`               | Sign governed environment manifests                                                                                   |
| `pnpm kyberion marketing publish-dry-run`     |                                     | Rehearse a marketing publish without sending anything.                                                                |
| `pnpm kyberion mcp server`                    | `pnpm mcp:server`                   | Run the MCP server on stdio                                                                                           |
| `pnpm kyberion media visual-proof-ds04`       |                                     | Generate the DS-04 video visual proof                                                                                 |
| `pnpm kyberion meeting consent`               | `pnpm meeting:consent`              | Capture voice consent                                                                                                 |
| `pnpm kyberion meeting participate`           | `pnpm meeting:participate`          | Join a meeting as a participant                                                                                       |
| `pnpm kyberion meeting run`                   | `pnpm meeting:run`                  | Run the meeting orchestrator                                                                                          |
| `pnpm kyberion meeting-notepad server`        |                                     | Start the meeting notepad pad                                                                                         |
| `pnpm kyberion memory-capture server`         |                                     | Start the memory capture pad                                                                                          |
| `pnpm kyberion mesh deliver`                  |                                     | Drive Mesh Hub delivery                                                                                               |
| `pnpm kyberion migration`                     | `pnpm migration`                    | Run pending migrations                                                                                                |
| `pnpm kyberion minutes record`                | `pnpm minutes:record`               | Record a meeting from the microphone into minutes                                                                     |
| `pnpm kyberion mission`                       | `pnpm mission`                      | Mission lifecycle: start, checkpoint, finish                                                                          |
| `pnpm kyberion mission orchestrator`          | `pnpm mission:orchestrator`         | Run the mission orchestration event worker                                                                            |
| `pnpm kyberion model feedback`                |                                     | Record model feedback                                                                                                 |
| `pnpm kyberion namespace migrate-physical`    | `pnpm namespace:migrate-physical`   | Plan or apply the physical tenant namespace migration                                                                 |
| `pnpm kyberion offboard`                      |                                     | Preview or run export-then-delete for a closing tenant or project                                                     |
| `pnpm kyberion office`                        | `pnpm office`                       | Open the Virtual Office surface                                                                                       |
| `pnpm kyberion organization`                  | `pnpm organization`                 | Manage the organization operating model and roles                                                                     |
| `pnpm kyberion pads server`                   | `pnpm pads`                         | Start the local capture pads server                                                                                   |
| `pnpm kyberion peer collaboration`            |                                     | Run a peer collaboration                                                                                              |
| `pnpm kyberion peer conversation`             | `pnpm peer:conversation`            | Converse with a peer runtime                                                                                          |
| `pnpm kyberion peer conversation-server`      | `pnpm peer:conversation-server`     | Start the peer conversation server                                                                                    |
| `pnpm kyberion peer migrate-tenant-runtime`   | `pnpm peer:migrate-tenant-runtime`  | Plan or apply the peer runtime tenant migration                                                                       |
| `pnpm kyberion peer register`                 | `pnpm peer:register`                | Register this runtime with the peer network                                                                           |
| `pnpm kyberion peer runtime-recovery`         | `pnpm peer:runtime-recovery`        | Recover the peer runtime                                                                                              |
| `pnpm kyberion peer send`                     |                                     | Send a peer message                                                                                                   |
| `pnpm kyberion personal-workbench server`     |                                     | Start the personal workbench                                                                                          |
| `pnpm kyberion pipeline`                      | `pnpm pipeline`                     | Run a governed pipeline                                                                                               |
| `pnpm kyberion pipeline dry-run`              |                                     | Dry-run a pipeline: validate and plan its steps without side effects.                                                 |
| `pnpm kyberion pipeline promote`              | `pnpm pipeline:promote`             | Promote a successful one-off run into a pipeline                                                                      |
| `pnpm kyberion pipeline super`                |                                     | Run a super pipeline                                                                                                  |
| `pnpm kyberion playground`                    | `pnpm playground`                   | Open the actuator playground                                                                                          |
| `pnpm kyberion plugin install`                | `pnpm plugin:install`               | Install a skill plugin (provenance-gated)                                                                             |
| `pnpm kyberion pr create`                     |                                     | Open a GitHub pull request after the readiness gates                                                                  |
| `pnpm kyberion pr shadow-observe`             |                                     | Shadow mode: read open pull requests and record what the autonomy gate would do with each (never merges or comments). |
| `pnpm kyberion presence stimuli`              |                                     | Inspect and manage presence stimuli for the operator's surfaces.                                                      |
| `pnpm kyberion project`                       | `pnpm project`                      | Manage governed projects                                                                                              |
| `pnpm kyberion project-os init`               | `pnpm project-os:init`              | Generate a project operating system                                                                                   |
| `pnpm kyberion project-trust request`         |                                     | Request trust for a project pipeline                                                                                  |
| `pnpm kyberion reconcile config-fallbacks`    |                                     | Sweep recorded config fallbacks into reviewable follow-ups.                                                           |
| `pnpm kyberion reconcile unclassified-errors` |                                     | Sweep unclassified errors into reviewable follow-ups.                                                                 |
| `pnpm kyberion reconcile unhandled-intents`   |                                     | Sweep unhandled intents into reviewable follow-ups.                                                                   |
| `pnpm kyberion reject`                        |                                     | Reject a pending request                                                                                              |
| `pnpm kyberion release install-smoke`         |                                     | Run the clean-install smoke test                                                                                      |
| `pnpm kyberion release notes`                 | `pnpm release:notes`                | Extract release notes from CHANGELOG.md                                                                               |
| `pnpm kyberion release source-archive`        | `pnpm release:source-archive`       | Build a deterministic source archive                                                                                  |
| `pnpm kyberion resolve install-driver`        |                                     | Install the generated-file merge driver                                                                               |
| `pnpm kyberion review stamp`                  |                                     | Stamp or strip the review layer in an HTML file                                                                       |
| `pnpm kyberion run`                           |                                     | Execute an actuator                                                                                                   |
| `pnpm kyberion schedule register`             |                                     | Register a scheduled pipeline                                                                                         |
| `pnpm kyberion schedule remove`               |                                     | Remove a scheduled pipeline                                                                                           |
| `pnpm kyberion scheduler`                     | `pnpm scheduler`                    | Run the Chronos scheduler daemon                                                                                      |
| `pnpm kyberion scheduler install`             |                                     | Install the Chronos launchd agent                                                                                     |
| `pnpm kyberion scheduler uninstall`           |                                     | Show Chronos launchd uninstall steps                                                                                  |
| `pnpm kyberion screenshot-annotate server`    |                                     | Start the screenshot annotation pad                                                                                   |
| `pnpm kyberion seam select`                   |                                     | Inspect, calibrate, and set seam provider selection                                                                   |
| `pnpm kyberion secret apply`                  |                                     | Apply an introduced secret                                                                                            |
| `pnpm kyberion secret introduce`              |                                     | Introduce a secret through a hidden prompt                                                                            |
| `pnpm kyberion secrets encrypt`               | `pnpm secrets:encrypt`              | Encrypt (or --decrypt) connection documents                                                                           |
| `pnpm kyberion service harness`               |                                     | Run the service harness                                                                                               |
| `pnpm kyberion service recording`             |                                     | Run the service recording flow                                                                                        |
| `pnpm kyberion sketch-input server`           |                                     | Start the sketch input pad                                                                                            |
| `pnpm kyberion skill install`                 |                                     | Install a skill bundle                                                                                                |
| `pnpm kyberion stance create`                 | `pnpm stance:create`                | Create a stance overlay (customer/{slug}/)                                                                            |
| `pnpm kyberion stance migrate-from-personal`  | `pnpm stance:migrate-from-personal` | Migrate personal data into a stance overlay                                                                           |
| `pnpm kyberion stance switch`                 | `pnpm stance:switch`                | Switch the active stance overlay                                                                                      |
| `pnpm kyberion surface outbox`                |                                     | Inspect or drain the surface notification outbox.                                                                     |
| `pnpm kyberion surfaces`                      | `pnpm surfaces`                     | Manage runtime surfaces                                                                                               |
| `pnpm kyberion sync component-inventory`      |                                     | Sync the actuator component inventory                                                                                 |
| `pnpm kyberion sync model-registry`           |                                     | Sync the model registry                                                                                               |
| `pnpm kyberion system upgrade`                | `pnpm system:upgrade`               | Upgrade the Kyberion installation                                                                                     |
| `pnpm kyberion task`                          |                                     | Plan or start a governed cross-tool task                                                                              |
| `pnpm kyberion task init`                     | `pnpm task:init`                    | Initialize a task                                                                                                     |
| `pnpm kyberion task run`                      | `pnpm task:run`                     | Run a task                                                                                                            |
| `pnpm kyberion task smoke`                    |                                     | Run the task smoke test                                                                                               |
| `pnpm kyberion task start`                    |                                     | Create a governed task session from a plan                                                                            |
| `pnpm kyberion telegram bridge`               | `pnpm telegram:bridge`              | Run the Telegram bridge                                                                                               |
| `pnpm kyberion tenant`                        | `pnpm tenant`                       | Manage tenants                                                                                                        |
| `pnpm kyberion tenant activation`             | `pnpm tenant:activation`            | Check or complete tenant activation                                                                                   |
| `pnpm kyberion tenant export`                 |                                     | Export one tenant's governed data as a portable bundle.                                                               |
| `pnpm kyberion tenant watch-drift`            | `pnpm tenant:watch-drift`           | Watch for tenant drift                                                                                                |
| `pnpm kyberion tui`                           | `pnpm tui`                          | Open the terminal HUD                                                                                                 |
| `pnpm kyberion validation-bundle export`      | `pnpm validation-bundle:export`     | Export the validation evidence bundle                                                                                 |
| `pnpm kyberion vault cleanup`                 |                                     | Clean up vault mounts                                                                                                 |
| `pnpm kyberion vault mount`                   |                                     | Mount a vault                                                                                                         |
| `pnpm kyberion vault unmount`                 |                                     | Unmount a vault                                                                                                       |
| `pnpm kyberion voice conversation-turn`       |                                     | Run one realtime voice conversation turn                                                                              |
| `pnpm kyberion voice profile-promote`         |                                     | Promote a voice profile                                                                                               |
| `pnpm kyberion voice upgrade`                 | `pnpm voice:upgrade`                | Upgrade the voice tier                                                                                                |
| `pnpm kyberion work`                          | `pnpm work`                         | Coordinate work items                                                                                                 |
| `pnpm kyberion workflow register`             |                                     | Register a new mission workflow from a compact registration request.                                                  |
| `pnpm kyberion workspace gc`                  |                                     | Garbage-collect stale workspaces                                                                                      |

## Developer commands

Repository build, test, generator and gate scripts for contributors.

| Command                                           | pnpm script                      | What it does                                                               |
| ------------------------------------------------- | -------------------------------- | -------------------------------------------------------------------------- |
| `pnpm kyberion build`                             | `pnpm build`                     | Build everything (packages, actuators, repo, UI)                           |
| `pnpm kyberion build actuators`                   | `pnpm build:actuators`           | Build actuators                                                            |
| `pnpm kyberion build bundle`                      | `pnpm build:bundle`              | Bundle hot script entry points                                             |
| `pnpm kyberion build packages`                    | `pnpm build:packages`            | Build shared packages                                                      |
| `pnpm kyberion build repo`                        | `pnpm build:repo`                | Compile repository TypeScript                                              |
| `pnpm kyberion build ui`                          | `pnpm build:ui`                  | Build the UI apps                                                          |
| `pnpm kyberion chat local`                        |                                  | Start an interactive local-LLM chat with tool use.                         |
| `pnpm kyberion check`                             | `pnpm check`                     | Run repository checks (pnpm check -- --scope pr before a PR)               |
| `pnpm kyberion check apple-fm`                    | `pnpm check:apple-fm`            | Check on-device Apple Intelligence availability                            |
| `pnpm kyberion check backend-conformance`         |                                  | Check reasoning backend conformance                                        |
| `pnpm kyberion check chronos-perf`                |                                  | Check Chronos performance baseline (browser)                               |
| `pnpm kyberion check commit-subject`              | `pnpm check:commit-subject`      | Check the HEAD commit subject                                              |
| `pnpm kyberion check contract-semver`             | `pnpm check:contract-semver`     | Check contract semver changes                                              |
| `pnpm kyberion check dead-code`                   |                                  | List dead-code candidates for review (advisory; deletes nothing).          |
| `pnpm kyberion check dep-cycles`                  | `pnpm check:dep-cycles`          | Check for dependency cycles                                                |
| `pnpm kyberion check improvement-plan-metadata`   |                                  | Check improvement plan metadata                                            |
| `pnpm kyberion check plugin-views-e2e`            |                                  | End-to-end check of Chronos plugin views                                   |
| `pnpm kyberion check pr-title`                    | `pnpm check:pr-title`            | Check a PR title against Conventional Commits                              |
| `pnpm kyberion check rt-mode`                     |                                  | Check the runtime mode configuration for consistency.                      |
| `pnpm kyberion check script-integrity`            |                                  | Check package script integrity                                             |
| `pnpm kyberion ci`                                | `pnpm ci`                        | Run the full CI sequence locally                                           |
| `pnpm kyberion deps check`                        | `pnpm deps:check`                | Check dependencies                                                         |
| `pnpm kyberion design import-md-catalog`          |                                  | Import a Markdown design catalog into the governed design data.            |
| `pnpm kyberion design verify-resolution`          |                                  | Verify layout and body-zone resolution for each scenario brief.            |
| `pnpm kyberion docs check`                        |                                  | Check docs for stale commands, broken links and unlisted pipelines         |
| `pnpm kyberion eval harness`                      |                                  | Run the deterministic, named eval harness table.                           |
| `pnpm kyberion eval intent-trace`                 |                                  | Trace how an utterance is classified and routed to an intent.              |
| `pnpm kyberion eval japanese-intent`              |                                  | Evaluate contextual Japanese intent classification against fixtures.       |
| `pnpm kyberion eval learning-efficiency`          |                                  | Benchmark how efficiently recorded learnings are reused.                   |
| `pnpm kyberion eval mission-orchestration`        |                                  | Evaluate mission orchestration quality on recorded scenarios.              |
| `pnpm kyberion eval model-role-fitness`           |                                  | Ask a model whether it can hold a team role before a mission relies on it. |
| `pnpm kyberion examples discover`                 | `pnpm examples`                  | Discover actuator example catalogs                                         |
| `pnpm kyberion format`                            | `pnpm format`                    | Format the repository with Prettier                                        |
| `pnpm kyberion generate artifact-kinds`           |                                  | Generate schema-backed artifact, intent and work policy types              |
| `pnpm kyberion generate capability-seams`         |                                  | Regenerate the capability seam graph                                       |
| `pnpm kyberion generate cli-reference`            | `pnpm generate:cli-reference`    | Regenerate the CLI command reference page                                  |
| `pnpm kyberion generate env-registry`             | `pnpm generate:env-registry`     | Regenerate the environment variable registry                               |
| `pnpm kyberion generate knowledge-index`          | `pnpm generate:knowledge-index`  | Regenerate the knowledge index                                             |
| `pnpm kyberion generate op-registry`              | `pnpm generate:op-registry`      | Regenerate the actuator op registry                                        |
| `pnpm kyberion generate pii-rules`                | `pnpm generate:pii-rules`        | Regenerate PII rules                                                       |
| `pnpm kyberion generate pseudo-locale`            | `pnpm generate:pseudo-locale`    | Regenerate the pseudo-locale catalog                                       |
| `pnpm kyberion generate service-harness-registry` |                                  | Regenerate the service harness registry.                                   |
| `pnpm kyberion generate trace-docs`               |                                  | Regenerate trace documentation from recorded traces.                       |
| `pnpm kyberion generate types`                    | `pnpm generate:types`            | Regenerate types                                                           |
| `pnpm kyberion generate vocabulary-types`         | `pnpm generate:vocabulary-types` | Regenerate vocabulary key types                                            |
| `pnpm kyberion i18n report`                       | `pnpm i18n:report`               | Report translation coverage                                                |
| `pnpm kyberion inventory resource-loaders`        |                                  | Inventory resource loader helpers                                          |
| `pnpm kyberion license audit`                     | `pnpm license:audit`             | Audit third-party licenses                                                 |
| `pnpm kyberion lint`                              | `pnpm lint`                      | Run ESLint                                                                 |
| `pnpm kyberion media intro-scratch`               |                                  | Build the scratch-first narrated intro video.                              |
| `pnpm kyberion patch dependency`                  |                                  | Apply a governed dependency patch                                          |
| `pnpm kyberion prepare`                           | `pnpm prepare`                   | Install git hooks                                                          |
| `pnpm kyberion provider-capabilities report`      |                                  | Report which capabilities each installed provider CLI supports.            |
| `pnpm kyberion release changelog-draft`           |                                  | Draft CHANGELOG entries from Conventional Commits since the last tag.      |
| `pnpm kyberion resolve generated`                 |                                  | Regenerate tracked generated files to resolve conflicts                    |
| `pnpm kyberion scenario run`                      | `pnpm scenario`                  | Run scenario files                                                         |
| `pnpm kyberion scenario storage-governance`       |                                  | Exercise the audit chain, data vault and process logger end to end.        |
| `pnpm kyberion smoke agent-pane-runtime`          |                                  | Smoke-test the opt-in pane agent-runtime launch mode.                      |
| `pnpm kyberion smoke intent`                      |                                  | Run the intent smoke test                                                  |
| `pnpm kyberion surfaces screenshots`              |                                  | Capture before/after screenshots of the UI surfaces.                       |
| `pnpm kyberion sync agent-profiles`               |                                  | Regenerate the agent profile index from the canonical profiles directory.  |
| `pnpm kyberion sync authority-roles`              |                                  | Regenerate the authority role index from the role definitions.             |
| `pnpm kyberion sync service-endpoints`            |                                  | Regenerate the service endpoint catalog from its sources.                  |
| `pnpm kyberion sync specialist-catalog`           |                                  | Regenerate the specialist catalog from its sources.                        |
| `pnpm kyberion sync team-roles`                   |                                  | Regenerate the team role index from the team role definitions.             |
| `pnpm kyberion test`                              | `pnpm test`                      | Run the test suite                                                         |
| `pnpm kyberion test unit`                         | `pnpm test:unit`                 | Run the unit test suite                                                    |
| `pnpm kyberion test watch`                        | `pnpm test:watch`                | Watch core tests                                                           |
| `pnpm kyberion typecheck`                         | `pnpm typecheck`                 | Typecheck the repository                                                   |
| `pnpm kyberion validate`                          | `pnpm validate`                  | Build, typecheck, and run full checks                                      |
| `pnpm kyberion verify`                            | `pnpm verify`                    | Typecheck, lint, and run unit tests                                        |

## Scopes and areas

### `pnpm kyberion doctor` `--scope <id>`

| Scope     | Runs                                   | What it does                                                       |
| --------- | -------------------------------------- | ------------------------------------------------------------------ |
| `env`     | `pnpm kyberion vital`                  | Local vitals: dependencies, build, identity files                  |
| `service` | `pnpm kyberion service preflight`      | Service connection readiness (auth and probe)                      |
| `voice`   | `pnpm kyberion doctor --runtime voice` | Voice runtime capabilities (audio, speech-to-text, text-to-speech) |
| `meeting` | `pnpm kyberion meeting preflight`      | Meeting readiness: devices, browser, consent                       |
| `app`     | `pnpm kyberion doctor --runtime app`   | Mobile app preflight (iOS/Android toolchain)                       |
| `setup`   | `pnpm kyberion setup report`           | Setup status and recommended surfaces                              |

### `pnpm kyberion setup` `<area>`

| Area           | Runs                               | What it does                                                             |
| -------------- | ---------------------------------- | ------------------------------------------------------------------------ |
| `onboarding`   | `pnpm kyberion onboarding`         | Run the onboarding wizard (identity, services, tenant)                   |
| `context`      | `pnpm kyberion onboarding context` | Resolve and bind the tenant/organization onboarding context              |
| `reasoning`    | `pnpm kyberion reasoning setup`    | Choose and configure the reasoning backend                               |
| `env`          | `pnpm kyberion env bootstrap`      | Probe an environment manifest; install missing capabilities with --apply |
| `services`     | `pnpm kyberion service setup`      | Connect external services (auth, presets, notifications)                 |
| `tools`        | `pnpm kyberion tool setup`         | Install or inspect system tool runtimes                                  |
| `provider-cli` | `pnpm kyberion provider-cli setup` | Install or inspect managed provider CLIs                                 |
| `agy-sdk`      | `pnpm kyberion agy sdk-setup`      | Set up the agy SDK managed environment                                   |
| `voice`        | `pnpm kyberion voice setup`        | Install local voice tools (speech-to-text, text-to-speech, VAD)          |
| `config`       | `pnpm kyberion config-mission`     | Extend configuration through a governed config mission                   |

## Deprecated aliases

Renamed entries keep working and print a one-line deprecation warning. Prefer the replacement.

### pnpm scripts

| Old                                   | Use instead                         |
| ------------------------------------- | ----------------------------------- |
| `pnpm intent`                         | `pnpm intent:trace`                 |
| `pnpm dev`                            | `pnpm verify`                       |
| `pnpm chronos`                        | `pnpm scheduler`                    |
| `pnpm inventory`                      | `pnpm work:inventory`               |
| `pnpm customer:create`                | `pnpm stance:create`                |
| `pnpm customer:list`                  | `pnpm stance:list`                  |
| `pnpm customer:migrate-from-personal` | `pnpm stance:migrate-from-personal` |
| `pnpm customer:switch`                | `pnpm stance:switch`                |
| `pnpm report:i18n-coverage`           | `pnpm i18n:report`                  |
| `pnpm migrate:physical-namespaces`    | `pnpm namespace:migrate-physical`   |
| `pnpm migrate:peer-tenant-runtime`    | `pnpm peer:migrate-tenant-runtime`  |
| `pnpm watch:tenant-drift`             | `pnpm tenant:watch-drift`           |
| `pnpm export:validation-bundle`       | `pnpm validation-bundle:export`     |
| `pnpm dev:watch`                      | `pnpm test:watch`                   |
| `pnpm agy:sdk:setup`                  | `pnpm agy:sdk-setup`                |
| `pnpm managed-env`                    | `pnpm provider-cli:setup`           |
| `pnpm onboard`                        | `pnpm onboarding`                   |
| `pnpm ingest`                         | `pnpm knowledge:ingest`             |
| `pnpm knowledge-feedback`             | `pnpm knowledge:feedback`           |
| `pnpm services:setup`                 | `pnpm service:setup`                |

### kyberion commands

| Old                                            | Use instead                                  |
| ---------------------------------------------- | -------------------------------------------- |
| `pnpm kyberion dev`                            | `pnpm kyberion verify`                       |
| `pnpm kyberion chronos`                        | `pnpm kyberion scheduler`                    |
| `pnpm kyberion inventory manage`               | `pnpm kyberion work inventory`               |
| `pnpm kyberion customer create`                | `pnpm kyberion stance create`                |
| `pnpm kyberion customer list`                  | `pnpm kyberion stance list`                  |
| `pnpm kyberion customer migrate-from-personal` | `pnpm kyberion stance migrate-from-personal` |
| `pnpm kyberion customer switch`                | `pnpm kyberion stance switch`                |
| `pnpm kyberion report i18n-coverage`           | `pnpm kyberion i18n report`                  |
| `pnpm kyberion migrate physical-namespaces`    | `pnpm kyberion namespace migrate-physical`   |
| `pnpm kyberion migrate peer-tenant-runtime`    | `pnpm kyberion peer migrate-tenant-runtime`  |
| `pnpm kyberion watch tenant-drift`             | `pnpm kyberion tenant watch-drift`           |
| `pnpm kyberion export validation-bundle`       | `pnpm kyberion validation-bundle export`     |
| `pnpm kyberion dev watch`                      | `pnpm kyberion test watch`                   |
| `pnpm kyberion managed env`                    | `pnpm kyberion provider-cli setup`           |
| `pnpm kyberion onboard`                        | `pnpm kyberion onboarding`                   |
| `pnpm kyberion ingest`                         | `pnpm kyberion knowledge ingest`             |
| `pnpm kyberion knowledge-feedback`             | `pnpm kyberion knowledge feedback`           |
| `pnpm kyberion services setup`                 | `pnpm kyberion service setup`                |
| `pnpm kyberion chronos install`                | `pnpm kyberion scheduler install`            |
| `pnpm kyberion chronos uninstall`              | `pnpm kyberion scheduler uninstall`          |
