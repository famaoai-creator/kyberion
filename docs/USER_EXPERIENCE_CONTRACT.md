# User Experience Contract

Kyberion uses many internal concepts, but it should expose a much smaller vocabulary at the human interaction boundary.
This document defines the contract between `internal execution concepts` and `user-facing language`.

For the broader enterprise framing above this contract, also read:

- `knowledge/product/architecture/organization-work-loop.md`
- `knowledge/product/architecture/enterprise-operating-kernel.md`
- `knowledge/product/architecture/ceo-ux.md`
- `knowledge/product/architecture/management-control-plane.md`
- `knowledge/product/architecture/corporate-memory-loop.md`

## Core Principle

Humans should not need to understand the full internal structure.
At the interaction boundary, Kyberion should consistently answer four questions:

1. What did the system understand?
2. What information is missing?
3. What will happen next?
4. What will be returned?

## Vocabulary Mapping

| Internal Concept            | User-Facing Label         | Meaning                                                          |
| --------------------------- | ------------------------- | ---------------------------------------------------------------- |
| execution brief             | Request understanding     | A normalized summary of the request and missing inputs           |
| resolution plan             | Execution plan            | A structured view of how the system intends to proceed           |
| pipeline bundle             | Execution bundle          | A bundle of execution templates                                  |
| capability bundle           | Capability bundle         | A reusable package of actuators, pipelines, governance, and docs |
| execution plan set          | Generated execution files | The concrete pipelines that will actually run                    |
| delivery pack               | Deliverable pack          | Main outputs, evidence, and summary                              |
| operator-interaction-packet | Interaction card          | A human-facing clarification, status, or delivery contract       |
| operator-response-preview   | Response preview          | A draft of what the system will say to the operator              |
| system-status-report        | Status report             | A structured report of system, mission, or project state         |

## Standard Conversation Shapes

### 1. Clarification

Use this shape when:

- the request is ambiguous
- required execution inputs are missing
- a branch choice materially changes the outcome

Show the operator:

- the understood request
- the missing information
- the recommended clarification question
- what remains blocked without that answer

### 2. Execution Preview

Use this shape when:

- work is about to begin
- the system needs to explain its intended path

Show the operator:

- the understood request
- the planned execution path
- the expected deliverables
- readiness, if relevant

### 3. Status Summary

Use this shape when the operator asks:

- "tell me the system status"
- "what is happening now"
- "what should we do next"

Show the operator:

- current state
- major findings
- next actions

### 4. Delivery Summary

Use this shape when:

- execution has completed
- deliverables are ready for review

Show the operator:

- produced deliverables
- supporting evidence
- what to review next

## Readiness Language

If the internal model has readiness states, the human-facing layer should prefer plain language such as:

- `ready to run`
- `needs clarification`
- `needs external assets`
- `missing runtime prerequisites`

Do not expose raw enum names or implementation-specific state labels unless they add operational value.

## Next Action Contract

A next action should be more than a suggestion.
Where possible, it should be directly runnable.

Next actions are not the same thing as missions.
A mission is a durable execution unit with ownership and lifecycle.
A next action is the immediate operator-facing step that may:

- execute something immediately
- inspect a current state or artifact
- request clarification
- start a new mission
- resume an existing mission

Useful fields include:

- `title`
- `reason`
- `next_action_type`
- `suggested_command`
- `suggested_pipeline_path`
- `suggested_followup_request`

When presenting a next action, explain the purpose before the technical detail.

## Layering Rule

Externally, Kyberion should default to four concepts:

- request
- execution unit
- deliverable
- next action

Internally, the system may still use:

- mission
- project
- actuator
- capability bundle
- ADF
- packet
- ledger

## Practical Writing Rule

The preferred answer order is:

1. What was understood
2. What is missing or problematic
3. What will happen next
4. What will be returned or what the current state is

That ordering keeps interaction understandable even when the internal system is complex.

## Internationalization Note

The canonical official wording should be maintained in English.
Localized operator-facing labels may be derived from a governed vocabulary catalog rather than hard-coded independently in each surface.

Free-form summaries, explanations, and clarification text do not need to be exhaustively cataloged.
Those may be generated by the LLM, as long as the underlying contract remains canonical and English-first.

## Surface Implementation Rule

When implementing a UI surface:

- fixed labels, section titles, button text, and status captions should use the governed vocabulary catalog
- missing vocabulary entries should fall back to English
- free-form summaries, explanations, and clarifications should not be duplicated into the catalog unless they become stable product language

This keeps the system maintainable when new locales are added.
It also prevents each surface from inventing a separate localization model.

## Concierge Conversation Continuity

The conversation dock restores the authenticated principal's transcript before
accepting a new request. The server binds the thread to the principal, member,
role, and complete tenant, organization, project, and tier permissions. Sharing
one administrator credential shares its principal and therefore its history.

Requests are persisted before orchestration. Restoring history never replays a
request, and historical approval buttons are not restored. A failed initial save
prevents execution; a failed final save displays the actual reply with an unsaved
warning. The durable text path uses the orchestrator's server-owned thread;
legacy voice-hub ingestion does not provide this durability guarantee.

Retention is bounded to 50 turns. At capacity, a completed turn or a pending turn
older than 24 hours may be removed. Current pending turns are protected. An
outcome arriving after its turn is removed is returned with the unsaved warning.
Pending-history status refreshes on page reload. Recognized credentials are
redacted before storage; arbitrary unrecognized secret text is not guaranteed to
be detected. Transcript restoration does not promise that every historical word
is injected into model context or that work continues while the service is off.

The next stages are supervised read-only background research, feedback memory,
and unified project context across channels. Always-on scheduling, learning from
corrections, and proactive notifications require separate implementation and
validation.

## Contract Test Hook

### Personal read-only review

The Concierge home offers a manual check and an explicit one-hour opt-in for
five-minute checks while the page remains mounted. Leaving the page, changing
the selected organization, request failure, or the one-hour deadline stops the
timer and cancels in-flight requests. This is browser polling; it does not claim
24-hour background operation or external notifications.

Each GET resolves the active server-authenticated member, narrows to one concrete
allowed tenant with a membership, and rechecks the original recording consent
at the start/end of the recording and at review time. Summaries without tenant
attribution and viewers restricted to organizations/projects are excluded because
the records cannot prove those scopes. Own-member data follows the existing
recording-panel self-service exception; confidential tenant visibility is also
required. No shared personal-tier projection is widened.

Only counts of pending summaries and summaries containing attention-required
operations are returned, from the last seven days and at most the newest 100
eligible summaries. App names, hosts, text, step descriptions, hashes and action
controls never enter this response. Errors clear the previous counts and stop
periodic checks. The fixed settings link provides consent and review controls.

Surface implementations should also be verifiable by automated checks.

Minimum checks:

- the response includes at least one of `Request`, `Plan`, `State`, `Result`, or `Next Action`
- default user-facing output does not leak internal-only terms such as actuator/operator schema internals
- approval-required responses explain both:
  - consequence of waiting or rejection
  - concrete unblock action
