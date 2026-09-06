`intent-resolution-packet.schema.json` is the canonical intermediate contract between natural-language surface input and governed work-shape execution.

The intent of this packet is to keep:

- heuristic candidates inspectable
- eventual LLM rerank pluggable
- selected work shape replayable
- reusable capability bundle candidates visible when an intent maps to a governed package
- the contextual scheduling frame captured during the same resolution pass

`bundle_candidates` is optional and only appears when Kyberion can map one
or more intent candidates to a governed `capability bundle` or
`actuator-pipeline-bundle`.
It is a discovery aid, not a second execution contract.

This packet is not the final execution contract.
It is the governed resolution artifact that sits before task-session, browser-session, mission, or direct-reply execution.
Consumers should reuse `contextual_frame` when present instead of re-running a
second free-text contextual resolver for the same turn.
