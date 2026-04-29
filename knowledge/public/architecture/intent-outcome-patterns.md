# Intent Outcome Patterns

## Purpose

This catalog defines the canonical completion pattern for each surface intent.

It complements the coverage matrix.

- the coverage matrix answers: `how complete is this intent today?`
- the intent outcome pattern catalog answers: `what does “done” look like for this intent?`

The governing chain is:

`intent -> contract -> execution -> outcome -> evidence -> follow-up`

## Core Pattern Types

### Artifact Generation

Used by:

- `generate-presentation`
- `generate-report`
- `generate-workbook`

Canonical shape:

1. normalize intent into `document_brief`
2. resolve `document_profile` and `sections`
3. compile into `design_protocol`
4. generate binary artifact
5. persist `artifact_record`

Done means:

- the binary exists in a governed path
- the artifact record exists
- the work loop captures reusable evidence

### Organization Toolchain Setup

Used by:

- `configure-organization-toolchain`

Canonical shape:

1. normalize onboarding toolchain request
2. inventory required organization integrations
3. map approval and trust boundaries
4. register the governed integration settings
5. persist the onboarding report

Done means:

- the requested CI/CD or workspace integration is recorded
- the approval boundary is explicit
- future missions can reuse the configured toolchain

### First-Run Onboarding

Used by:

- `launch-first-run-onboarding`

Canonical shape:

1. normalize the first-run request
2. identify the operator's workspace and baseline goals
3. surface required integrations and default presentation preferences
4. produce a setup plan for the first session

Done means:

- the onboarding path is explicit instead of implied
- the operator sees what gets configured next
- the flow can continue into toolchain and theme registration

### Presentation Preference Registration

Used by:

- `register-presentation-preference-profile`

Canonical shape:

1. normalize the deck preference request
2. validate the profile schema
3. choose the storage tier or overlay path
4. persist the reusable profile
5. return the default brief question set and theme hint

Done means:

- the theme and brief preferences are stored in governed knowledge
- future presentation work can start from the saved profile
- no hard-coded branch is needed to preserve the user's style

### Bootstrap

Used by:

- `bootstrap-project`

Canonical shape:

1. normalize project goal
2. create governed project record
3. resolve default track
4. create kickoff task session and mission seeds

Done means:

- the project record exists
- the governed root path exists
- first follow-up work items are seeded

### Analysis to Follow-Up

Used by:

- `cross-project-remediation`
- `incident-informed-review`

Canonical shape:

1. normalize analysis intent
2. resolve governed process design
3. rank governed refs
4. bind targets where possible
5. classify impact
6. generate governed analysis artifact
7. create follow-up seeds

Done means:

- the `.analysis.md` artifact exists
- findings and execution contracts exist
- follow-up seeds exist when project context is available

### Benchmark-Driven Harness Evolution

Used by:

- `evolve-agent-harness`

Canonical shape:

1. normalize the harness-improvement request
2. resolve the target harness and fixed adapter boundary
3. run the baseline benchmark or evaluation corpus
4. choose one general improvement
5. rerun and compare score or pass-rate delta
6. persist a keep or discard report with replayable evidence

Done means:

- the baseline exists
- the retained change respects the protected boundary
- keep or discard is justified by benchmark evidence
- the experiment report can be replayed or audited later

### Direct Reply

Used by:

- `knowledge-query`
- `live-query`

Canonical shape:

1. normalize question
2. resolve source scope
3. fetch answer material
4. synthesize reply

Done means:

- a governed answer is returned
- the answer remains grounded in the appropriate source scope

### Schedule Coordination

Used by:

- `schedule-coordination`

Canonical shape:

1. normalize the request into schedule scope and date range
2. resolve fixed constraints and calendar boundary
3. propose or apply the schedule change
4. record the follow-up path or meeting handoff

Done means:

- the schedule constraints are explicit
- the output says whether the calendar was updated or only proposed
- any meeting-specific handoff is visible

### Conversation Orchestration

Used by:

- `clarify-user-request`
- `continue-conversation`
- `summarize-conversation`
- `conversation-to-mission`

Canonical shape:

1. normalize the current thread and user goal
2. identify whether the request needs clarification, continuation, summarization, or escalation
3. preserve conversational context while composing the reply
4. return either a clarification packet, reply, summary, or mission brief

Done means:

- the thread stays coherent across turns
- missing inputs are surfaced explicitly instead of being guessed
- the current exchange can be summarized or escalated into a governed mission brief

### Browser Session

Used by:

- `open-site`
- `browser-step`

Canonical shape:

1. normalize browser action
2. resolve destination or active session
3. execute browser action
4. retain browser session state

Done means:

- the page or step is executed
- the next browser turn can continue from retained session state

## Why This Matters

Kyberion should not treat intents as flat labels.

An intent is only genuinely implemented when its completion pattern is clear across:

- contract
- execution
- outcome
- evidence
- follow-up

Machine-readable source:

- [intent-outcome-patterns.json](/Users/famao/kyberion/knowledge/public/governance/intent-outcome-patterns.json)
