---
title: Scratch Tool Promotion
kind: howto
scope: repository
authority: reference
phase: [execution, review]
tags: [scratch-first, promotion, tools, pipeline, tenant, retention]
owner: ecosystem_architect
last_updated: 2026-10-20
---

# Scratch Tool Promotion

## What this is

Discovery work leaves builders, scripts and ADF under `active/shared/tmp/<job>/`. That floor is consumable: the janitor deletes it after the tmp TTL (`storage-retention-catalog.json`, 1 day). This playbook keeps the useful parts, in three steps:

1. **scratch** — prototype under `active/shared/tmp/<job>/` (or the tenant partition `active/shared/tmp/confidential/<tenant>/<domain>/<job>/`) until the result is accepted.
2. **tool** — `pnpm scratch:promote` copies the authored files into a durable tool directory with a `TOOL.json` manifest.
3. **op + pipeline** — move the deterministic logic into typed actuator ops, wire a pipeline, and register it with `pnpm pipeline:promote` (`--tenant <slug>` for tenant work).

Step 2 only keeps the files. It is not the end state. Steps that need fresh model judgment stay semantic briefs. See [scratch-to-pipeline-video-promotion](./scratch-to-pipeline-video-promotion.md) for the same shape applied to video.

## Promote a scratch builder (tool)

```bash
pnpm scratch:promote --from active/shared/tmp/<job>/work --name <tool> --tenant <slug>
pnpm scratch:promote --from active/shared/tmp/public/shared/<domain>/<job> --name <tool> --public
#   [--entry <file>] [--dry-run] [--force]
```

- `--tenant <slug>` writes to `knowledge/confidential/<slug>/tools/<tool>/`. The slug must be a registered, active tenant.
- `--public` writes to `knowledge/public/tools/<tool>/`. It is refused when the source is in a personal or confidential tier, or in a tenant-partitioned floor path: a public target would downgrade that data. Unpartitioned scratch (`active/shared/tmp/<job>/`, `active/shared/staging/<job>/`, an unpartitioned mission directory) has no declared tier and often holds confidential material, so `--public` from there is refused too unless you add `--source-is-public` to confirm the content is public. Default to `--tenant`.
- Tier and tenant segments are matched case-insensitively, so `Confidential/` cannot slip past the guard.
- The source must be under `active/shared/tmp/`, `active/shared/staging/` or `active/missions/`.
- Only authored text files are copied: code, ADF/JSON, YAML, Markdown and similar. `node_modules`, binaries and generated outputs (`.pptx`, `.pdf`, `.png`, …) are skipped, as are files over 512 KiB. The whole copy is capped at 200 files and 5 MiB.
- `TOOL.json` records `name`, `promoted_at`, `source`, `files[{path, sha256}]`, `entrypoints`, a best-effort `run` command, `inputs` and `follow_up`.
- `--force` replaces an earlier promotion. Files the previous `TOOL.json` listed but the new copy lacks are removed. If the target holds files that no manifest lists, the command refuses.
- The command leaves `.scratch-promoted.json` in the scratch directory. That file is the promotion record the janitor looks for.

## Ledger record for tenant promotions

A tenant promotion lands a tenant asset, so it is recorded in the tenant's information-asset ledger (`knowledge/confidential/<slug>/_ledger/assets.jsonl`, the same DA-05 ledger `pnpm knowledge:ingest` writes). Public promotions and `--dry-run` record nothing.

| Command                                          | `source_system` / `source_id`     | `transform_chain`      | `target_path` and `content_sha256` |
| ------------------------------------------------ | --------------------------------- | ---------------------- | ---------------------------------- |
| `scratch:promote --tenant` (incl. `--candidate`) | `scratch` / the scratch directory | `scratch_promote:tool` | the written `TOOL.json`            |
| `pipeline:promote --tenant`                      | `adf` / the source ADF file       | `pipeline_promote`     | the written pipeline JSON          |

- `visible_to` is the tenant. `ingested_by` is `KYBERION_PERSONA`, else `MISSION_ROLE`. With neither set, the command refuses before it writes anything.
- `source_id` is the real source path, also for `--candidate`. That is safe: the tier guard only lets a tenant promote its own partition or unpartitioned scratch, and the record stays in that tenant's ledger.
- A `--force` re-promotion with new content appends version+1 with `supersedes: <asset_id>@v<n>`. Identical content keeps the earlier `promoted_at`, so the file is byte-identical and no record is added (`recorded: false`).
- A re-promotion from a new source onto the same target starts a new asset at version 1 whose `supersedes` names the asset that held the target. One source cannot feed two targets: the command refuses with a ledger conflict.
- The ref (`asset:<asset_id>@v<n>`) is returned as `asset` and written to `.scratch-promoted.json`. It is not written into `TOOL.json` or the pipeline: the ledger hashes those bytes, and a pipeline's project-trust approval is bound to them.

## Promote an ADF (pipeline)

```bash
pnpm pipeline:promote --input <adf.json> --run <run-id> --tenant <slug>   # → knowledge/confidential/<slug>/pipelines/<name>.json
pnpm pipeline:promote --input <adf.json> --run <run-id> [--source-is-public]   # → pipelines/<name>.json (public catalog)
pnpm pipeline:promote --input <adf.json> --draft [--tenant <slug>]   # inert proposal in scoped scratch; no catalog entry
```

Run the exact ADF first in the target scope and use the engine's `run_id` (printed by `pnpm pipeline --input <adf.json> --json`). For a mission-owned run, also pass `--mission <id>`. Promotion resolves its protected journal and requires one successful terminal outcome, completed source steps, the same source bytes and data scope, and engine trace binding. An unknown, failed, interrupted, recovered-primary, cross-tenant, or legacy run cannot establish executable promotion. Use `--draft` while exploring; the draft wraps the ADF as proposal data outside executable catalogs. `--dry-run` previews the selected operation and does not bypass evidence verification.

`promotion.status=verified_source` proves the original source run. The abstracted ADF receives its own contract digest and schema/guardrail validation; its first real execution still needs outcome verification. Installing a shipped repository template through the governed installer is a separate distribution operation, marked `unverified_template`, and does not claim run success or execute effects.

Tenant mode adds a row to `knowledge/confidential/<slug>/pipelines/README.md` and creates that file if it is missing. It never touches the public `pipelines/README.md`. Without `--tenant`, a source in a personal or confidential tier, or in a tenant-partitioned path, is refused with a diagnostic pointing at `--tenant`. So is an unpartitioned scratch source, unless `--source-is-public` is given. A source from another tenant is refused in either mode.

Tenant promotions write through the narrow `asset_promoter` authority role, bound to the target tenant. It may write only that tenant's `pipelines/`, `tools/` and `_ledger/`, its own scratch partitions and the unpartitioned scratch floors (for the promotion record). `scratch:promote --public` uses the separate, tenant-less `public_tool_promoter` role, which may write only `knowledge/public/tools/` and the unpartitioned scratch floors. Public `pipeline:promote` keeps writing `pipelines/` as `ecosystem_architect`.

Tenant pipelines are project-local, so they run only with a human-approved project-trust decision. That decision is bound to the file content: every promotion, including a `--force` re-promotion, needs a fresh one. `pipeline:promote --tenant` prints these steps on every run (prefixed `(dry-run)` on a dry run) and returns them as `next_steps`:

```bash
pnpm kyberion project-trust request knowledge/confidential/<slug>/pipelines/<name>.json
# a human approves the request
pnpm pipeline --input knowledge/confidential/<slug>/pipelines/<name>.json --project-trust-approval <id>
```

The tenant README's Run column shows the same governed command.

## Repair triage with media:pptx_package_diff

When a generated deck opens with "needs repair", let PowerPoint repair a copy, save it as `<deck> - Repaired.pptx`, and diff the two packages instead of reading XML by hand:

```json
{
  "action": "pipeline",
  "name": "pptx-repair-triage",
  "steps": [
    {
      "id": "diff",
      "op": "media:pptx_package_diff",
      "params": {
        "before": "active/shared/tmp/<job>/deck.pptx",
        "after": "active/shared/tmp/<job>/deck - Repaired.pptx"
      }
    }
  ]
}
```

Read the result in this order:

1. `only_in_before` / `only_in_after`: parts PowerPoint dropped or added (orphan or missing parts).
2. `[Content_Types].xml` and the `*.rels` entries in `changed`: broken relationships and missing content types.
3. The slide parts in `changed`.

Skip entries with `noise_only: true`. These are differences PowerPoint introduces on every save: attribute order, font subsets, `docProps`, and `xmlns` churn. The first entry that is not noise is usually the real defect. Fix the generator, not the repaired copy, then re-run `media:pptx_package_check` on the new output until it reports `ok`.

## Sweeper grace (if you forget)

The tmp entry of the retention catalog declares `code_grace_days` (default 2). A job directory gets that many extra days when both of these hold:

- it contains authored code (`*.ts`, `*.mts`, `*.js`, `*.mjs`, `*.py`, `*.sh`) or an ADF (`*.json` with a top-level `steps` array);
- it has no promotion record (`TOOL.json` or `.scratch-promoted.json`).

Only job directories with at least one file past the TTL are examined, and code extensions are checked before any JSON file is read. The job directory is `tmp/<job>/`, `tmp/system/<domain>/<job>/` or `tmp/<tier>/<tenant|shared>/<domain>/<job>/`. Its files are kept until `mtime + ttl + code_grace_days`. While the grace runs, the janitor:

- logs a warning (`what — why | next | evidence`) with the exact `pnpm scratch:promote --from … --name … --tenant …` command;
- lists the directory in `active/shared/runtime/system/scratch-promotion-candidates.json`, with `id` (a hash of the directory salted with a per-install random salt kept in `active/shared/runtime/system/scratch-promotion-salt.json`, so an id cannot confirm a guessed path), `dir`, `files`, `first_seen`, `delete_after` and `command`. That file sits in the system partition, which carries no tenant data. A tier-partitioned job is therefore recorded only as `id` + `tier`: no tenant slug, job name or file names, in the file or in the warning. To promote one, run `pnpm scratch:promote --candidate <id> --tenant <slug> --name <tool>`. Under the tenant-bound role it scans only that tenant's own tmp/staging partitions for the job directory whose salted id matches, then promotes it; an id never resolves in another tenant. File names are also withheld for unpartitioned jobs; only system-partition jobs list them.

When the grace ends, the files are deleted as before and the directory leaves the list. Directories without code get no grace. Neither do promoted directories.
