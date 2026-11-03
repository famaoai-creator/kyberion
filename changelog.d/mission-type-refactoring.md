### Added

- Mission type `refactoring` (and explicit `code_change`) routes to class `code_change`, with a dedicated `code-refactoring-aidlc` workflow that binds the engineering refactoring playbook (audit → behavior pin → atomic reshape → equivalence verify).
- Engineering refactoring playbook enriched with external AI-agent practices (act101, VS Code agent guide, characterization/Mikado loops, LLM refactoring research).
- Refactoring utterance/hint promotion selects `code-refactoring-aidlc`; team staffing aliases `refactoring`/`code_change` onto the `development` template; phase gates require `check_refactoring_evidence` proofs, not empty files.

### Fixed

- Refactoring knowledge wiring: intent catalog, class operating guide, knowledge-slices pins, mission-template injections, stale public refactor procedure → playbook pointer, and fidelity-protocol disambiguation (not code refactoring).
