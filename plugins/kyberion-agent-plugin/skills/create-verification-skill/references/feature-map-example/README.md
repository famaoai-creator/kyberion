# Example verification map (shape only)

This directory is a **shape reference** for generated `features/` trees. Replace every concrete
name with the target app. Do not treat Notes as a real Kyberion product surface.

## Baseline preconditions

- Launch the app with a disposable data directory (unique per `RUN_ID`).
- Prefer Kyberion sense/actuators for observation when available.
- Run the generated skill's `doctor` and require expected URL/port/build revision.
- Never drive an instance that was not started by this verification run.

## Driving conventions

- Start every recipe from the baseline state unless preconditions say otherwise.
- Prefer ARIA roles / accessible names / prompt strings over CSS position.
- Treat every command as literal.
- Restore seeded data after a mutation. Do not remove proof artifacts during cleanup.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final screen.
- UI proof: snapshot + screenshot with app identity visible.
- CLI proof: command, stdout, stderr, exit code.
- Mutation proof: a read-only second view of the stored value.
- Report an unreachable path with the attempted command and unmet precondition.
- Do not report a skipped entry point as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 and one paragraph of user-visible behavior, then exactly
four H2 sections in order:

1. `Sub-features`
2. `How to get to it (user POV)`
3. `Driving it with <harness>`
4. `Gotchas`

## Features

- [Create a note](./create-note.md) — creation, cancellation, persistence (example).
- [Search notes](./search.md) — match, empty, clear (example).
