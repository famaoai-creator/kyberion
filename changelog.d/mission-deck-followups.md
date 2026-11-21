---
category: Fixed
---

- **Mission Deck follow-ups** — five review leftovers from the first Mission Deck release:
  - Processes the deck starts (herdr, `mission_controller`, `kyberion approvals`) now run on the operator's own base role. Before, they inherited the deck's `sovereign` read role.
  - herdr calls can no longer be misread as flags. A target or approval id that starts with `-` is refused. Reply text that starts with `-` gets a leading space, because herdr 0.9 has no uniform `--` marker (`agent attach` rejects it).
  - When the deck runs from source, mission pause/resume/checkpoint run the source `mission_controller`, not a possibly stale `dist/` build.
  - Switching the language (`L`) now also reaches the data worker, so loader-built text changes language right away. This includes the in-process fallback.
  - The stdin pause before a terminal handoff now has a test, as does the role the child receives.
