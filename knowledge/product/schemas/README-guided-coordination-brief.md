# Guided Coordination Brief

`guided-coordination-brief.schema.json` is the shared intake contract for repeated outcome-driven work.
It comes before specialized execution briefs and domain-specific overlays.

Use it before specialized briefs such as:

- `meeting-operations-profile`
- `presentation-preference-profile`
- `booking-preference-profile`
- `narrated-video-preference-profile`
- `travel-planning-brief`

The shared brief captures:

- the original request
- the coordination kind
- the objective
- the domain overlay
- the relevant service binding references
- the missing inputs
- the expected outputs
- the approval boundary
- the preference profile references

The specialized brief can then narrow the work further without re-encoding the shared flow.
Do not place raw secrets, credentials, or device-specific paths in this brief.
