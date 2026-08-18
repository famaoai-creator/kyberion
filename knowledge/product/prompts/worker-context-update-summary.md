---
title: Worker context update summary prompt
tags: [worker, compaction, context, checkpoint]
last_updated: 2026-08-17
---

Update the existing worker context summary with the new transcript.

Preserve decisions already marked complete. Keep unresolved work explicit by
moving `In Progress` items forward only when the transcript proves they are
done. Retain important constraints, verified facts, active artifacts, and the
next concrete step. Include cumulative read-file and modified-file context
when it is supplied. The output must stand alone if the older transcript is
discarded; do not mention hidden prompts or omit a previously established
decision merely because it is not repeated in the new transcript.
