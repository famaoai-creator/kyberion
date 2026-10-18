---
category: Added
---

- **`pnpm playground -- --help` prints usage instead of entering the wizard** — the flag previously fell through to interactive mode, and `-h` works too.
- **`--params @path/to/file.json` loads parameters from a repository file** — for payloads too large to paste inline; the same form works in the interactive JSON-paste prompt.
- **Interactive wizard shows the declared parameter surface** — required/optional fields and the first catalog example are printed before prompting, ops list their kind (`capture`/`apply`/…), mistyped `--actuator`/`--op` values warn instead of silently reopening the list, and selections accept an actuator id or op name in addition to a number.
