# Mission Logic Engine (MLE)

Reflexive execution engine for established mission logic (pipelines). It executes predefined sequences of skills and provides a Signal Mailbox for autonomous intervention.

## 📋 Role & Responsibility

- **Reflexive Execution**: Executes `logic.yml` (Pipeline) files with high speed and zero inference overhead.
- **Neural Hook**: Detects failures and provides structured `signals/*.json` to the AI (Cortex) for self-correction.
- **Traceability**: Automatically records execution steps and outcomes in `TASK_BOARD.md`.

## 🛠 Usage

```bash
node dist/scripts/cli.js run mission-logic-engine --pipeline <path_to_logic.yml> --signal-dir <path_to_signals>
```

### Arguments

- `--pipeline`, `-p`: Path to the YAML-defined mission logic.
- `--signal-dir`, `-s`: Directory to output signals on failure or checkpoint. Defaults to `active/missions/{ID}/signals/`.
- `--vars`, `-v`: Key-value pairs to hydrate pipeline placeholders (e.g. `--vars dir=src`).

## 🧠 Mission Logic Lifecycle (MLE Integration)

MLE is the **Deterministic (Reflex)** phase of the mission lifecycle:

1. **Alignment**: Human defines intent.
2. **Heuristic**: AI creates initial `TASK_BOARD.md` and manually refines the process.
3. **Distillation**: `wisdom-distiller` generates `logic.yml`.
4. **MLE Execution (Deterministic)**: Future similar missions use MLE to replay the `logic.yml` instantly.

## 🛡️ Neural Hook Protocol (Signal Mailbox)

When MLE encounters an error:
1. It pauses execution.
2. It writes a structured JSON signal to the specified `signal-dir`.
3. It informs the AI that intervention is required.
4. AI reads the signal, fixes the issue, and resumes MLE.
