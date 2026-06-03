# Meeting Facilitation Workflow Simplification Proposal

**Date**: 2026-05-04  
**Target**: `pipelines/meeting-facilitation-workflow.json`

## 1. Goal

Keep the live meeting flow explicit while moving action-item handling and tracking to the already-existing follow-up pipelines.

## 2. Current Shape

The current pipeline includes:

- meeting join
- facilitation script generation
- transcript listening
- action-item extraction
- speaker fairness audit
- meeting leave
- post-meeting guidance

The pipeline is useful, but the responsibility boundary is wider than necessary.

## 3. Existing Split Points

The repository already contains separate follow-up pipelines:

- `pipelines/action-item-execute-self.json`
- `pipelines/action-item-tracking.json`

This means the meeting flow does not need to own follow-up execution or reminder loops.

## 4. Proposed Target Shape

### 4.1 Keep in meeting workflow

Keep only the parts that belong to live facilitation:

- open / join meeting
- listen for a bounded duration
- record or expose transcript evidence
- leave meeting
- emit a concise handoff summary

### 4.2 Move out of meeting workflow

Move the following out of the primary meeting flow:

- operator self-execution reminder logic
- recurring action-item tracking
- any follow-up loop that is not required to close the live session

### 4.3 Keep only one extraction boundary

If action-item extraction must remain in the meeting pipeline, keep it as a single extraction handoff.

If the extraction result can be consumed by a downstream pipeline directly, then the meeting pipeline should only emit the transcript artifact and let the follow-up pipeline consume it.

## 5. Concrete Refactoring Moves

### 5.1 Reduce logging noise

The current logs are useful, but they are too frequent for the amount of state they carry.

Prefer:

- one start log
- one brief log
- one extraction summary log
- one close log

### 5.2 Compress meeting actuator usage

`join`, `listen`, and `leave` are the essential live-ops actions.

They should remain visible, but the wrapper logic around them should be trimmed.

### 5.3 Separate audit from live facilitation

Speaker fairness audit is a useful observation, but it is not part of the live facilitation path.

If the audit must remain, it should be treated as a post-listen evidence step rather than a core meeting action.

## 6. Suggested Step Boundary

Recommended final sequence:

1. `open_log`
2. `log_brief`
3. `join`
4. `facilitate_open`
5. `listen`
6. `capture_transcript_summary`
7. `leave`
8. `wrap`

Optional downstream follow-up:

- `action-item-execute-self.json`
- `action-item-tracking.json`

## 7. Success Criteria

- the live meeting flow is easier to scan
- follow-up work is delegated to existing pipelines
- action item handling no longer bloats the live flow
- the pipeline still records enough evidence to reconstruct the session

## 8. Implementation Order

1. trim log noise
2. narrow the live flow to join/listen/leave plus one evidence handoff
3. keep action-item follow-up in the dedicated pipelines

---
*Proposal distilled on 2026-05-04*
