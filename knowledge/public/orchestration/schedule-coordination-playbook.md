# Schedule Coordination Playbook
This playbook specializes the shared [Guided Coordination Protocol](knowledge/public/orchestration/guided-coordination-protocol.md) for calendar reshuffling work.

## Intent

Use `schedule-coordination` when the user wants to adjust, reschedule, or align calendar commitments without necessarily running a live meeting.

Examples:

- `スケジュールを調整して`
- `来週の予定を変更したい`
- `打ち合わせの日程をずらしたい`
- `カレンダーを組み直して`

## When to route here

- The request is about changing times, slots, or commitments.
- The user wants proposed options or direct calendar edits.
- The request is not primarily about facilitating a live meeting.
- If the schedule change is about a meeting, route to `schedule-coordination` first, then hand off to `meeting-operations` when the meeting-specific authority or facilitation boundary matters.

## When not to route here

- If the request is about attending or facilitating a live meeting, use `meeting-operations`.
- If the request is about booking restaurants, hotels, or services, use `lifestyle-booking`.
- If the request is only to view the calendar or open a site, use `open-site`.

## Preflight

Ask only for the missing inputs that matter:

- `schedule_scope`: whose calendar or commitments are changing
- `date_range`: which time window is being moved
- `fixed_constraints`: which commitments cannot move
- `calendar_action_boundary`: whether to propose options or apply changes directly
- `meeting_handoff_boundary`: when the schedule change is about a meeting, whether this is only a calendar edit or should be handed to `meeting-operations`

## Execution path

1. Build the execution brief.
2. Resolve the task session contract.
3. Check calendar availability and conflicts using the browser calendar management procedure.
4. Propose one or more viable adjustments.
5. If the target is a live meeting and the `meeting_handoff_boundary` says to hand it off, hand off to `meeting-operations`.
6. Apply the chosen change only when the boundary permits it.
7. Record the updated schedule and follow-up path.

## Outputs

- `schedule_coordination_summary`
- calendar update evidence
- follow-up reminders or action items when requested

## Safety boundary

- Do not modify calendars or send notifications unless the authority boundary is explicit.
- Keep `schedule-coordination` as the umbrella intent for generic calendar reshuffling.
- Use `meeting-operations` as the leaf intent when the request is specifically about a live meeting's participation, facilitation, decisions, or action items.
