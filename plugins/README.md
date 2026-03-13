# Plugins

Extend skill execution with beforeSkill/afterSkill lifecycle hooks.

## Usage

Create `.kyberion-plugins.json` in your working directory:

```json
{
  "plugins": ["./plugins/execution-guard.js", "./plugins/perf-profiler.js"]
}
```

Plugins are loaded automatically by `skill-wrapper.js` during `runSkill()`.

## Available Plugins

| Plugin                  | Hooks              | Purpose                                                    |
| ----------------------- | ------------------ | ---------------------------------------------------------- |
| `metrics-collector.js` | `afterSkill`       | In-memory execution metrics collection                     |
| `output-logger.js`     | `afterSkill`       | JSONL logging to `work/plugin-output.log`                  |
| `execution-guard.js`   | `before` + `after` | File type blocking, audit logging, slow execution warnings |
| `tier-enforcer.js`     | `afterSkill`       | Scans outputs for leaked confidential markers              |
| `perf-profiler.js`     | `afterSkill`       | Performance regression detection (rolling window)          |

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
