---
category: Added
---

- **Interactive actuator work now reaches the pipeline.** `pnpm kyberion browser control export <BCS-…>` compiles a control session's **completed** steps into a reviewed `browser-recording.v1` (status `pending`; unexecuted steps are dropped and reported), `recordings`/`recordings show` list and inspect them, `review` records decisions, and `promote <session>|--recording <BCR-…>` runs the governed promote-procedure path with an auto-derived procedure id and intent phrases. `fill` values are scrubbed from journals at write time and `browser control open <url> --approval <id>` resumes the documented approval instead of creating a new one.
- **System-actuator ops run without authoring a pipeline.** `pnpm kyberion system <op>` wraps one op in a one-step ADF the actuator accepts (`system ops` lists the vocabulary; `interact` reaches `computer_interaction`). Raw-command ops (`exec`/`shell`/`run_js`/`run_applescript`/`run_shortcut`) and pipeline flow-control ops (`if`/`while`) stay off this surface — governed pipelines still reach them.
- **`pnpm kyberion ops`** lists every actuator domain's op vocabulary grouped by step kind, read from the same governed `actuator-op-registry` pipeline authors validate against.
