`intent-resolution-packet.schema.json` is the canonical intermediate contract between natural-language surface input and governed work-shape execution.

The intent of this packet is to keep:

- heuristic candidates inspectable
- eventual LLM rerank pluggable
- selected work shape replayable

This packet is not the final execution contract.
It is the governed resolution artifact that sits before task-session, browser-session, mission, or direct-reply execution.
