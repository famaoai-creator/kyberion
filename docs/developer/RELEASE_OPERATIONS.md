---
title: Release Operations
category: Developer
tags: [release, semver, conventional-commits, changelog]
importance: 8
last_updated: 2026-05-07
---

# Release Operations

How Kyberion gets versioned, tagged, and released. Phase D'-4 of `docs/PRODUCTIZATION_ROADMAP.md`.

## Versioning

Kyberion follows [Semantic Versioning](https://semver.org/):

- `0.x.y` until v1.0.0. While in 0.x, **minor bumps may be breaking** (per semver convention for pre-1.0). We still call them out as `BREAKING CHANGE` in the changelog.
- After v1.0.0, the [stability tiers](./EXTENSION_POINTS.md#stability-tiers) determine what counts as breaking.

Each actuator has its own semver in its `manifest.json`. The repo `package.json` version is a separate axis. The repo version follows the tightest bump across all stable surfaces.

## Conventional Commits

We use [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/):

```
<type>(<optional scope>): <subject>

<optional body>

<optional footer, e.g. BREAKING CHANGE: …>
```

| Type | Bump |
|---|---|
| `feat:` | minor |
| `fix:` | patch |
| `perf:` | patch |
| `refactor:` | patch (no observable behavior change) |
| `docs:` | none (rolled into the next bump) |
| `test:` | none |
| `build:` / `ci:` / `chore:` | none |
| `feat!:` or any with `BREAKING CHANGE:` footer | major |

PRs must use one of these types. CI rejects PR titles that do not match the pattern, and pushes to `main` reject commit subjects that do not match the pattern.

## Release cadence

- **Patch (`0.x.y` → `0.x.y+1`)**: as needed, when a `fix:` lands.
- **Minor (`0.x.y` → `0.x+1.0`)**: monthly, on the last Friday of the month.
- **Major (`0.x.y` → `1.0.0`)**: triggered by Phase D' completion (per `PRODUCTIZATION_ROADMAP.md`).

Pre-releases use `-alpha.N`, `-beta.N`, `-rc.N` suffixes.

## Release runbook

```bash
# 1. On main, ensure CI is green.
git fetch && git checkout main && git pull
pnpm install --frozen-lockfile
pnpm run validate       # full validate including check:contract-semver

# 2. Decide the new version.
#    - patch / minor / major per the rules above.
#    - For minor, scan unreleased commits with `pnpm tsx scripts/generate_changelog.ts`.
NEW_VERSION="0.x.y"

# 3. Generate changelog entries from commits since the last tag.
pnpm tsx scripts/generate_changelog.ts --prepend

# 4. Edit CHANGELOG.md:
#    - Move the [Unreleased] additions to a new ## [<version>] - <YYYY-MM-DD> section.
#    - Add a fresh empty [Unreleased] section at the top.
#    - Review wording.
#    - Keep a "Migration required" subsection explicit:
#      write "None" when no migration applies, or list each migration/<id>.ts script.

# 5. Bump version in package.json + workspaces.
node -e "
const fs=require('fs');
const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));
pkg.version='${NEW_VERSION}';
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2)+'\n');
"

# 6. If any actuator surfaces changed and require a version bump,
#    update their manifest.json versions and run:
pnpm run check:contract-semver -- --rebaseline
#    Review and stage scripts/contract-baseline.json with the release prep.

# 7. Commit the release prep.
git add CHANGELOG.md package.json scripts/contract-baseline.json migration/
git commit -m "chore(release): v${NEW_VERSION}"

# 8. Tag the release.
git tag -a "v${NEW_VERSION}" -m "Release v${NEW_VERSION}"
git push origin main
git push origin "v${NEW_VERSION}"

# 9. Publish a GitHub Release with the same notes as CHANGELOG.md.
pnpm run release:notes -- --ref "v${NEW_VERSION}" --output active/shared/tmp/release-notes.md
gh release create "v${NEW_VERSION}" --title "v${NEW_VERSION}" \
  --notes-file active/shared/tmp/release-notes.md

# 10. (Optional) Build and push Docker images.
docker buildx build --platform linux/amd64,linux/arm64 \
  -t ghcr.io/famaoai-creator/kyberion-playground:v${NEW_VERSION} \
  -t ghcr.io/famaoai-creator/kyberion-playground:latest \
  --push .
```

## Migration scripts

If the release introduces a schema or path change, add a migration script under `migration/` (see [`migration/README.md`](../../migration/README.md)). Reference it in the changelog under "Migration required".

Release prep is not complete until the migration state is explicit:

- If no migration is required, the release changelog section must say `Migration required: None`.
- If a migration is required, add `migration/<sequence>-<slug>.ts`, document operator impact and rollback expectations in the changelog, and run `pnpm migration:run -- --dry-run` before tagging.
- If actuator contract surfaces changed, update manifest versions and commit the refreshed `scripts/contract-baseline.json` produced by `pnpm run check:contract-semver -- --rebaseline`.

## Hotfix branch policy

For urgent fixes to a non-current minor:

```bash
git checkout v0.5.x   # or create from the tag if no such branch exists
git checkout -b hotfix/0.5.x-<slug>
# ... fix and test ...
# Then merge into main AND create a tag like v0.5.4
```

We support the latest minor of the latest major + the latest minor of the previous major (post 1.0). See `SECURITY.md`.

## Pre-1.0 quirks

- We may break minor → minor while in 0.x. We try not to, and always document.
- Phase milestones in `PRODUCTIZATION_ROADMAP.md` map roughly to minor bumps:
  - Phase A complete → 0.1.0
  - Phase B complete → 0.2.0
  - Phase C' complete → 0.3.0
  - Phase D' complete → 1.0.0

## Status

- [x] CHANGELOG.md initialized
- [x] `scripts/generate_changelog.ts`
- [x] `migration/` directory + README
- [x] PR title / commit message linter
- [x] Automated release workflow (`.github/workflows/release.yml`)
- [x] Migration runner (`scripts/run_migrations.ts`)
