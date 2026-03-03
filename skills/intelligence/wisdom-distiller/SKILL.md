# Wisdom Distiller

Distills mission results into reusable logic pipelines (YAML). It converts successful sequences from `TASK_BOARD.md` into standard `pipelines/*.yml`.

## 📋 Role & Responsibility

- **Process Extraction**: Analyzes completed `TASK_BOARD.md` files to identify repeatable skill sequences.
- **Parametrization**: Replaces hardcoded paths/values with `{{vars}}` to ensure portability.
- **Pipeline Generation**: Outputs structured YAML files to the `pipelines/` directory.

## 🛠 Usage

```bash
node dist/scripts/cli.js run wisdom-distiller --mission MSN-123 --name my-new-logic
```

### Arguments

- `--mission`, `-m`: ID of the completed mission to distill.
- `--name`, `-n`: Descriptive name for the resulting pipeline (e.g. `code-refactor`).
- `--out-dir`, `-o`: Directory to save the YAML file. Defaults to `pipelines/`.

## 🧠 Wisdom Distillation Lifecycle

1. **Mission Completion**: AI achieves Victory Conditions in a Heuristic mission.
2. **Distillation**: Human or AI triggers `wisdom-distiller`.
3. **Crystallization**: The manual trial-and-error is converted into a deterministic `logic.yml`.
4. **Reflex**: Subsequent missions use `mission-logic-engine` to run the logic instantly.
