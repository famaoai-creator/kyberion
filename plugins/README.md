# Plugins

Extend skill execution with beforeSkill/afterSkill lifecycle hooks.

## Usage

Create `.gemini-plugins.json` in your working directory:

```json
{
  "plugins": ["./plugins/execution-guard.cjs", "./plugins/perf-profiler.cjs"]
}
```

Plugins are loaded automatically by `skill-wrapper.cjs` during `runSkill()`.

## Available Plugins

| Plugin                  | Hooks              | Purpose                                                    |
| ----------------------- | ------------------ | ---------------------------------------------------------- |
| `metrics-collector.cjs` | `afterSkill`       | In-memory execution metrics collection                     |
| `output-logger.cjs`     | `afterSkill`       | JSONL logging to `work/plugin-output.log`                  |
| `execution-guard.cjs`   | `before` + `after` | File type blocking, audit logging, slow execution warnings |
| `tier-enforcer.cjs`     | `afterSkill`       | Scans outputs for leaked confidential markers              |
| `perf-profiler.cjs`     | `afterSkill`       | Performance regression detection (rolling window)          |

## Configuration

### execution-guard

| Env Var                  | Default  | Description                                            |
| ------------------------ | -------- | ------------------------------------------------------ |
| `GUARD_BLOCKED_EXTS`     | _(none)_ | Comma-separated blocked extensions (e.g., `.exe,.bat`) |
| `GUARD_WARN_DURATION_MS` | `5000`   | Slow execution warning threshold                       |

### perf-profiler

Stores rolling performance data in `work/perf-profile.json`. Warns when execution time exceeds 2× the historical average.

## Writing a Plugin

```javascript
module.exports = {
  beforeSkill(skillName, args) {
    // Called before skill execution
  },
  afterSkill(skillName, output) {
    // Called after skill execution
    // output: { status, data, metadata, error }
  },
};
```

**Rules:**

- Plugins MUST NOT throw errors that break skill execution
- Each hook is wrapped in try-catch by the skill-wrapper
- Plugins load in array order; a failing plugin doesn't block others
