---
category: Changed
---

- **Fresher objective progress**: `pnpm organization objective kr measure --force` re-measures key results inside their interval (an incident opened a minute ago now shows up), `objective kr add --every <seconds>` sets a key result's interval (default 900, minimum 60), and objective lines in `measure` / `status` show how old the oldest measurement is (`· measured 12m ago`).
- **Clearer organization CLI guidance**: an unknown option is reported by name (`Unknown option --to for 'pnpm organization decision transition'`) instead of as an unknown command. `organization status` separates proposed decisions from those awaiting a human approval, lists open incidents with the transition command, and for resolved incidents names where to write the post-incident review needed to close them.
