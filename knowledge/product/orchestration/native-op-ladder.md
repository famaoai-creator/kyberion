# Native operation selection ladder

Distilled demonstrations choose the narrowest deterministic capability first:

1. exact deterministic op;
2. existing actuator op or governed CLI;
3. browser/session operation;
4. desktop GUI replay only when no API or CLI can express the task.

The mapping source is `observation-to-op-map.json`. The right-hand side is
validated against `actuator-op-registry.json`; a missing op is a CI error.
This document is guidance only. It does not grant execution authority or skip
human review and approval gates.
