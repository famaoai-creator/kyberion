// Help text for the mission controller CLI. Lives outside mission_controller.ts
// so the entry point stays under the source max-lines ratchet; the text is
// static and carries no controller state.
export function buildHelpText(): string {
  return `
Kyberion Sovereign Mission Controller (KSMC)

Usage: node dist/scripts/mission_controller.js <command> [args]

Lifecycle Commands:
  create   <ID>                  Create a new mission (status: planned)
                                 ID convention: <PREFIX>-<TOPIC>-<YYYYMMDD> (e.g. MSN-LOG-OPT-20260930)
                                 repo-internal work needs --tier public (default is confidential)
  kickoff  <ID>                  One-step create+start: creates the mission if absent, then activates
                                 it (same options as start: --tier --goal --success-condition)
  start    <ID>                  Activate a mission (planned/paused/failed → active)
                                 --goal <TEXT> carries the user goal into the intent baseline
                                 --success-condition <TEXT> records the acceptance condition
                                 --intent-goal <PATH> accepts an existing governed handoff file
                                 --decided-by user:<member-id> [--decided-by-name <TEXT>] [--decided-by-role <owner|approver|viewer>]
                                 records the human member who made this decision (optional)
  checkpoint [task_id] [note]    Record a checkpoint on the focused mission
  checkpoint <ID> <task_id> <note>
                                 Record a checkpoint on an explicit mission
  verify   <ID> <verified|rejected> <note>
                                 Verify a mission (active → distilling or back to active)
  distill  <ID>                  Extract knowledge via LLM (distilling → completed)
  finish   <ID> [--seal]         Archive a completed mission (optionally encrypt)
  resume   [ID]                  Resume the last active mission and replay orchestration journal (or specify ID)
  pause    <ID> [--note <TEXT>] [--decided-by user:<member-id>] [--decided-by-name <TEXT>] [--decided-by-role <owner|approver|viewer>]
                                 Pause an active mission without losing state
  cancel   <ID> [--note <TEXT>] [--decided-by user:<member-id>] [--decided-by-name <TEXT>] [--decided-by-role <owner|approver|viewer>]
                                 Cancel a mission and mark it failed for follow-up
  repair   <ID> [--note <TEXT>]  Repair legacy mission state via the governed controller
  dispatch-tickets <ID>          Register NEXT_TASKS as work items / issue payloads
                                 --ticket-targets workitem,github,jira
                                 --live-ticket-targets github,jira
                                 --github-owner <OWNER> --github-repo <REPO>
                                 --jira-domain <DOMAIN> --jira-project-key <KEY>
  dispatch-workitems <ID>        Execute registered work items via agent/subagent routing
                                 --dispatch-mode auto|agent|subagent
                                 --dispatch-execution-surface cli_subagent|agent_runtime|hybrid
                                 --dispatch-review-execution-surface cli_subagent|agent_runtime|hybrid
                                 --dispatch-statuses ready,backlog
                                 --dispatch-rounds N (auto-retry blocked items, bounded)
                                 --dispatch-sources local,github,jira
                                 --dispatch-final-status review|done
  hygiene [--notify]             List stuck planned missions with per-mission remediation
                                 --stale-days N (default 2) --abandoned-days N (default 14)
  sweep-empty-dirs [--execute]   Preview ledger-free empty dirs under active/missions
                                 (--execute removes; file-free subtrees only)

Delegation Commands:
  delegate <ID> <agent_id> <a2a_message_id>
                                 Delegate a mission to an external agent
  import   <ID> <remote_url>     Import results from a delegated mission
  seal     <ID>                  Encrypt a mission for archival (AES+RSA)

Queue Commands:
  enqueue  <ID> <tier> [priority] [deps]
                                 Add a mission to the dispatch queue
  dispatch                       Start the next queued mission
  memory-queue [status]          List memory promotion candidates
                                 Show readiness, blockers, and physical duplicate count
  memory-review <CANDIDATE_ID> [--tenant-slug <SLUG>] [--json]
                                 Show summary, target, evidence, scope, audit, and next action
  memory-approve <CANDIDATE_ID> [--tenant-slug <SLUG>] [--knowledge-domain product|organization|personal] [--owner-nhi <NHI>] [--curation-json <JSON>] [--note <TEXT>] [--decided-by user:<member-id>] [--decided-by-name <TEXT>] [--decided-by-role <owner|approver|viewer>]
                                 Curate mission knowledge and approve only when review preflight is clear
  memory-reject <CANDIDATE_ID> [--tenant-slug <SLUG>] [--all-duplicates] [--note <TEXT>] [--decided-by user:<member-id>] [--decided-by-name <TEXT>] [--decided-by-role <owner|approver|viewer>]
                                 Mark a memory candidate as rejected
  memory-promote <CANDIDATE_ID> [--tenant-slug <SLUG>] [--execution-role <mission_controller|chronos_gateway>] [--note <TEXT>] [--supersedes <PATH_OR_ID>]
                                 Promote an approved candidate to governed knowledge
  memory-promote-pending [--execution-role <mission_controller|chronos_gateway>] [--note <TEXT>] [--supersedes <PATH_OR_ID>] [--dry-run]
                                 Bulk promote approved memory candidates in queue order

Visibility Commands:
  list     [status]              List all missions (optionally filter by status)
  status   <ID> [--refresh-providers]
                                 Show detailed status of a specific mission and backend availability
  outbox   [ID] [--ack]          Show mission results delivered to the terminal surface (--ack to clear)
  sync-project-ledger <ID>       Upsert this mission into the related project mission-ledger
  reassign-project <ID> --project-id <PROJECT_ID> [--project-path <PATH>] [--track-id <TRACK_ID>] [--dry-run] [--force]
                                 Safely move a paused/planned mission to another project and reconcile both sides
  team     <ID> [--refresh] [--summary] [--provider <ID>] [--model <ID>]
                                 Show or regenerate mission team composition
                                 --summary prints roster / staffed / standby / unfilled and the
                                 obligations that shaped the roster instead of the raw plan JSON
  staff    <ID> [--provider <ID>] [--model <ID>]
                                 Spawn or verify runtime instances for assigned mission team roles
  advise   <ID> --question <TEXT> [--topic <TEXT>] [--roles <CSV>] [--context <TEXT>]
                                 Consult the mission's own roster: each member answers from its role,
                                 the panel cross-critiques the answers, and the outcome is recorded
                                 in the mission execution ledger
  propose-roster <ID> [--context <TEXT>] [--force]
                                 Ask the reasoning backend to propose discretionary roles beyond the
                                 derived roster. Off unless the governed policy enables it (--force
                                 runs it anyway); every proposal must pass the same checks as restaff
  restaff  <ID> <TEAM_ROLE> [--capabilities <CSV>] [--exclude <AGENT_CSV>] [--reason <TEXT>]
                                 Add a role to a running mission's roster (bounded by max_members,
                                 same capability / authority / separation-of-duties checks as
                                 composition) and materialize its runtime
  classify <ID> [intent] [task]  Classify mission context into class/delivery/risk/stage
  workflow-select <ID> [intent] [task]
                                 Resolve workflow template from mission classification
  plan-tasks <ID> [--force] [--refresh-catalog]
                                 Expand process template phases into NEXT_TASKS.json + gates (--refresh-catalog re-resolves from the current catalog)
  review-worker-output <ID> [verified|rejected] [note]
                                 Record worker-output review result via mission verification
  handoff <ID> <persona> [note]  Transfer mission persona ownership with audit history

Governance Commands:
  accept-with-override <HYPOTHESIS_OR_BRANCH_ID> --reason "<text>" [--severity warn|poor]
                                 Record a rubric override (counterfactual warn/poor accepted by operator).
                                 Emits the rubric.override_accepted audit event per
                                 counterfactual-degradation-policy.json. Required for warn-severity
                                 acceptance; forbidden for poor unless tenant_risk_officer documents
                                 the exception separately.

Maintenance Commands:
  record-task <ID> <description> Record a task intention (flight recorder)
  record-evidence <ID> <task_id> <note>
                                 Append an execution-ledger evidence entry and commit it
  review-task <ID> <review_task_id> <reviewer_agent_id> [--findings <JSON>] [--reviewer-team-role reviewer|qa] [--specialist-roles <CSV>]
                                 Record a real ArtifactReviewReceipt for a review-kind task (required before it
                                 can complete — bare record-evidence is not enough for review tasks). Independence
                                 from the implementer is computed from the execution ledger, not self-declared.
                                 --findings: JSON array of {severity: blocking|suggestion, category, description,
                                 required_action?, location?}; anything else is rejected before a receipt is written.
  reconcile-work <ID> --manifest <PATH> [--dry-run] [--approval-request-id <UUID>]
                                 --request-approval [--requested-by <ACTOR>] creates a hash-bound human approval request
                                 --generate [--output <PATH>] scaffolds a manifest from current git state
                                 Validate and adopt verified work completed outside dispatch-workitems
  review-reenter <ID>            Turn pending human review rejections into rework tasks and reactivate the mission
  scope-approve <ID> [--goal <TEXT>] [--reason <TEXT>] [--success-condition <TEXT>]
                                 Approve a scope change and rebaseline the origin intent.
                                 Direct use requires SUDO; without it: --request-approval
                                 files a human approval request (decide via
                                 'pnpm kyberion approvals --approve <id>'), then apply with
                                 --approval-request-id <id> — hash-bound to the exact
                                 goal/reason/success-condition the human read
  triage   <ID> [--json] [--request-approval] [--goal <TEXT>] [--reason <TEXT>]
                                 Diagnose why a mission is not closed and print the
                                 lowest-privilege path out. --request-approval files the
                                 scope-approval request when classification is
                                 intent_drift_blocked
  purge    [--execute]            Preview stale missions to archive (--execute to apply)
  archive  [--execute] [--mission <ID>]
                                 Governed archive verb: policy-driven sweep like purge (dry-run by
                                 default), or archive one completed/failed mission now via --mission
    sync                           Sync mission registry
  organization-catalogs [--json] [--organization-id <ORG>] [--selected-only] [--summary]
                                 List available organization team template catalogs
  organization-profiles [--json] [--organization-id <ORG>] [--active-only] [--ready-only] [--missing-only] [--source <customer|public>] [--summary]
                                 List available organization profiles
  organization-profile [--json] [--organization-id <ORG>] [--summary]
                                 Show the resolved organization profile and defaults
  organization-discovery [--json] [--summary]
                                 Show the discovery overview and common paths
                                 Guide: knowledge/product/orchestration/organization-discovery.md
                                 Examples: knowledge/product/schemas/organization-discovery-report.example.json
                                           knowledge/product/schemas/organization-profile-report.example.json
                                           knowledge/product/schemas/organization-profiles-report.example.json
                                           knowledge/product/schemas/organization-catalog-report.example.json

  Typical Workflow:
  kickoff (one-step create+start) or create → start → checkpoint (repeat) → verify → distill → finish

Mission Input Contract:
  Positionals:
    <ID>                         Only the mission ID should be positional for create/start
  Preferred named options:
    --tier <personal|confidential|public>
    --tenant-id <TENANT>
    --tenant-slug <slug>           # multi-tenant isolation (^[a-z][a-z0-9-]{1,30}$)
    --organization-id <ORG>        # selects KYBERION_CUSTOMER for org-specific defaults
    --org <ORG>                    # alias for --organization-id
    --mission-type <TYPE>
    --vision-ref <REF>            Defaults to the active customer vision when KYBERION_CUSTOMER is set
    --persona <NAME>
    --dry-run
    --relationships <JSON>
    --relationships-file <PATH>
    --mission-id <ID>            Explicit mission target for checkpoint

Organization Selection:
  --organization-id <ORG>        Select a specific organization profile and template catalog
  --org <ORG>                    Alias for --organization-id
  --summary                      Print only the resolved organization summary (organization-profile)
  --active-only                  Filter organization-profiles to the selected organization only
  --ready-only                   Filter organization-profiles to ready profiles only
  --missing-only                 Filter organization-profiles to missing profiles only
  --source <customer|public>     Filter organization-profiles by source
  Guide: knowledge/product/orchestration/organization-selection-guide.md

Organization Discovery:
  organization-profiles --json --summary
                                 Inventory organization readiness as JSON
  organization-profile --json --summary
                                 Inspect one resolved organization profile as JSON
  organization-catalogs --json --selected-only --summary
                                 Inspect the selected team template overlay as JSON
  Reports: knowledge/product/orchestration/organization-discovery-reports.md
  Examples: knowledge/product/schemas/organization-discovery-report.example.json
            knowledge/product/schemas/organization-profile-report.example.json
            knowledge/product/schemas/organization-profiles-report.example.json
            knowledge/product/schemas/organization-catalog-report.example.json

  Validation:
    Linked project missions must point to a project_path whose 04_control ledger
    is writable under the current authority. Unsafe targets like libs/core will fail fast.

  Project Traceability Options:
  --project-id <ID>              Link mission to a project identifier
  --project-path <PATH>          Record the related project-os path
  --project-relationship <TYPE>  belongs_to | supports | governs | independent
  --affected-artifacts <CSV>     Comma-separated project artifacts impacted by the mission
  --gate-impact <TYPE>           none | informational | review_required | blocking
  --traceability-refs <CSV>      Comma-separated evidence or document refs
  --project-note <TEXT>          Free-text note for the project relationship
                                 Linked missions auto-sync to active/projects/<tier>/<tenant_or_shared>/<project_id>/state/
                                 and later distill into knowledge/product/evolution/ or knowledge/product/incidents/

Intent-to-Track Gate Options:
  --intent-id <ID>               Resolve the intent to a governed project track before create/start
  --intent-confidence <0..1>     Confidence score; below policy threshold requires confirmation
  --confirm-intent-track <REASON> Explicitly confirm low-confidence track provisioning
  --execution-shape <SHAPE>      Gate only mission/project_bootstrap shapes when specified

Track Traceability Options:
  --track-id <ID>                Link mission to a project track identifier
  --track-name <NAME>            Human-readable track name
  --track-type <TYPE>            delivery | release | change | incident | operations | governance
  --lifecycle-model <MODEL>      Track lifecycle profile (for example default-sdlc)
  --track-relationship <TYPE>    belongs_to | supports | governs | independent
  --track-traceability-refs <CSV> Comma-separated track-level refs
  --track-note <TEXT>            Free-text note for the track relationship
`;
}
