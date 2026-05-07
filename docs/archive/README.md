# Archive

Documentation that is **no longer current** but kept for trend archaeology, legal record, or future reference. **Do not write new content here.**

If you arrive here from a search result or a stale link: the canonical, current doc lives elsewhere. Check `docs/{user,operator,developer}/` or the file referenced in [`README.md`](../../README.md).

## Why each file is archived

| File | Why archived | Date |
|---|---|---|
| `LEGEND.md` | Storytelling / project lore. Not operational. | 2026-05-07 |
| `PERFORMANCE_DASHBOARD.md` | Self-declared "historical pre-manifest skill telemetry snapshot". The current runtime inventory is in `knowledge/public/orchestration/global_actuator_index.json`. | 2026-05-07 |
| `CONCEPT_INTEGRATION_BACKLOG.md` | Workflow tracking doc (P0/P1 items). Most items completed by 2026-04-20; the rest are tracked in `docs/PRODUCTIZATION_ROADMAP.md`. | 2026-05-07 |
| `sample_design.md` | One-line stub. Replaced by real samples under `templates/verticals/` and `pipelines/`. | 2026-05-07 |
| `sample_req.md` | One-line stub. Same as above. | 2026-05-07 |

## How to retrieve archived content

These files are still committed. To read or restore:

```bash
cat docs/archive/<file>.md
# or restore to root:
git mv docs/archive/<file>.md docs/<file>.md
```

History via `git log --follow docs/archive/<file>.md` reaches back to before the archive move.
