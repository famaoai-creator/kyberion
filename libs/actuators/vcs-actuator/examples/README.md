# VCS Actuator — Examples

See [CAPABILITIES_GUIDE.md](../../../../CAPABILITIES_GUIDE.md) for the full actuator catalog.

Requires the `git` binary on PATH. The `pr_create` op additionally requires
the GitHub CLI (`gh`) authenticated via `gh auth login`.

## Status (porcelain check in a pipeline)

```json
{
  "op": "vcs:status",
  "params": {
    "short": true
  },
  "export_as": "git_status"
}
```

## Log (recent history)

```json
{
  "op": "vcs:log",
  "params": {
    "limit": 10,
    "oneline": true
  },
  "export_as": "git_log"
}
```

## Commit (stage-all checkpoint)

```json
{
  "op": "vcs:commit",
  "params": {
    "message": "Checkpoint mission progress",
    "add": true
  },
  "export_as": "git_commit"
}
```
