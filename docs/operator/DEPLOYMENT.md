---
title: Kyberion Deployment Runbook
category: Operator
tags: [deployment, install, runbook, fde]
importance: 9
last_updated: 2026-07-02
---

# Kyberion Deployment Runbook

How to deploy Kyberion in three reference environments. This is the document an FDE engineer or operator follows when standing up a customer or self-hosted instance.

For development setup, see [`../QUICKSTART.md`](../QUICKSTART.md). This document is for **operational deployment**: machines that will run Kyberion in service, not just developer workstations.

## 0. Pre-deployment Checklist

Before installing on any environment:

- [ ] Decide single-user vs. customer-overlay (FDE) mode. Customer-overlay = define `KYBERION_CUSTOMER` and prepare `customer/{slug}/`.
- [ ] Decide reasoning backend: `claude-cli` (preferred when CLI is authenticated), `anthropic` (API key), `codex-cli`, `gemini-cli`, `agy-cli`, `copilot` (GitHub Copilot CLI via ACP), `openrouter` (OpenRouter API), `nemotron-api` (OpenAI-compatible endpoint), or `stub` (offline).
- [ ] Decide voice tier: tier 0 (browser + native TTS, no install), tier 1 (cloud), tier 2 (local Style-Bert-VITS2).
- [ ] Identify which actuators the use case needs (browser? voice? media? meeting?). Heavy ones (Playwright, Style-Bert-VITS2) only install if needed.
- [ ] Identify secrets storage strategy: OS keychain (preferred), env vars, or `customer/{slug}/secrets.json` (dev only).

---

## 1. macOS Workstation

For: Founders, FDE engineers running Kyberion on their own laptop, single-user power users.

### 1.1 Prerequisites

```bash
# Apple Silicon (arm64) is the primary CI target. Intel works but is less tested.
# Required:
brew install node@24 git
corepack enable
corepack prepare pnpm@11.13.0 --activate
node --version   # must be >= 24.0.0
pnpm --version   # must be 11.13.0

# Optional, only if you'll use these actuators:
brew install --cask google-chrome   # for browser-actuator (Playwright also installs Chromium)
brew install python@3.11            # for Style-Bert-VITS2 / Whisper (tier 2 voice)
brew install ffmpeg                 # for media composition
brew install tesseract              # for OCR
```

### 1.2 Install

```bash
git clone https://github.com/famaoai-creator/kyberion.git
cd kyberion
pnpm install
pnpm build
```

### 1.3 Configure (single-user)

```bash
pnpm surfaces reconcile     # bring up background surfaces
pnpm onboarding                # interactive identity setup → active stance overlay / personal fallback
```

### 1.4 Configure (FDE / customer overlay)

```bash
pnpm stance:create customer-slug
$EDITOR customer/customer-slug/customer.json
$EDITOR customer/customer-slug/identity.json
$EDITOR customer/customer-slug/vision.md

pnpm stance:switch customer-slug
source active/shared/runtime/customer.env
pnpm onboarding
```

For tenant-bound work, continue with [the standard onboarding flow](../../knowledge/product/governance/onboarding-flow.md): register the canonical tenant profile, bind the organization context, complete the activation probes, and obtain human acceptance before starting first work.

### 1.5 Verify

```bash
pnpm kyberion doctor                 # preflight: must, should, nice
pnpm dashboard              # visual status
```

For optional heavy capabilities, prefer governed bootstrap manifests over manual package-manager steps:

```bash
pnpm env:bootstrap --manifest meeting-participation-runtime
```

### 1.6 Run

For interactive use:

```bash
pnpm chronos:dev            # opens browser surface at http://127.0.0.1:3000
```

For background services:

```bash
pnpm agent-runtime:supervisor   # in one terminal (or use a launchd plist)
pnpm scheduler                    # optional scheduled pipeline daemon
pnpm mission:orchestrator       # in another
```

### 1.7 Production launchd (optional)

Register this checkout's resident services with one idempotent command. It reads
`knowledge/product/governance/resident-services.json` (chronos and the daemon watchdog
are required; `agent-runtime-supervisor` is optional; `generation-schedule` is owned by
its surface while that surface is enabled), syncs the schedule registry, compares the
desired units with what the host service manager already has, and installs
checkout-scoped units (`com.kyberion.<id>.ws-<hash>`) with distinct log names and a
pinned runtime root:

```bash
pnpm kyberion scheduler reconcile                 # dry-run: plan only
pnpm kyberion scheduler reconcile --apply         # install / migrate / reinstall
pnpm kyberion scheduler reconcile --apply --include agent-runtime-supervisor
pnpm kyberion scheduler status                    # live manager status (per daemon: --daemon <id>)
```

Rerunning it changes nothing unless the unit content or node path changed. A legacy
fixed-name unit (`com.kyberion.chronos`, …) that runs **this** checkout is migrated:
reconcile boots it out, removes its plist and installs the scoped unit. Units that run
another checkout are reported and never touched. The record of what reconcile installed
is `active/shared/runtime/state/resident-services.json`. The per-daemon verbs
(`pnpm kyberion scheduler install|start|stop|restart|uninstall [--daemon <id>]`) remain
for single-service work.

See [multi-instance scheduler operations](../../knowledge/product/orchestration/multi-instance-scheduler.md)
for schedule ownership and explicit legacy-global management (`--legacy-global`).

The fixed-name templates under `docs/operator/macos/` are retired: do not copy them
into `~/Library/LaunchAgents/`. They exist only as a reference for an existing
single-instance deployment; run `pnpm kyberion scheduler reconcile --apply` from that
checkout to migrate it to scoped units.

The watchdog reads daemon heartbeats from `active/shared/runtime/heartbeats/` and records
an ops alert to `active/shared/observability/ops-alerts.jsonl` when a configured daemon is
missing, stale, or malformed. If `KYBERION_OPS_ALERT_WEBHOOK_URL` is set, the same alert is
also delivered to that webhook.

---

## 2. Linux Server (Ubuntu 22.04 / 24.04)

For: customer-controlled VMs, internal infrastructure, persistent always-on Kyberion instances.

### 2.1 Prerequisites

```bash
# Required
sudo apt-get update
sudo apt-get install -y curl git build-essential
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
corepack enable
corepack prepare pnpm@11.13.0 --activate

# Optional (only for actuators that need them)
sudo apt-get install -y python3.11 python3-pip ffmpeg tesseract-ocr
# Playwright system deps:
sudo apt-get install -y libnss3 libnspr4 libatk-bridge2.0-0 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2
```

### 2.2 Install

```bash
sudo useradd -m -s /bin/bash kyberion
sudo -iu kyberion
git clone https://github.com/famaoai-creator/kyberion.git
cd kyberion
pnpm install --frozen-lockfile
pnpm build
```

### 2.3 Secrets

Linux has no built-in OS keychain equivalent to macOS Keychain. Use one of:

1. **systemd `LoadCredential=`** — secrets are exposed to the service as credential files; map the needed values into the process environment with a protected wrapper or environment file.
2. **`secret-actuator` opt-in file backend** — set `KYBERION_ALLOW_FILE_SECRETS=1`; Kyberion stores this backend under `vault/secrets/` with owner-only permissions.
3. **Environment variables** — inject service-scoped values through a protected systemd environment file.

For production, prefer `LoadCredential=` or a protected environment file. The opt-in file backend is intended for hosts where its local file permissions and storage protection meet the operator's policy.

### 2.4 systemd units

Prefer the same `pnpm kyberion scheduler reconcile --apply` ceremony above; on
Linux it plans per-instance systemd **user** services/timers. The root-level fixed-name
templates below are legacy single-instance examples — do not use them for new installs.

Templates live under `docs/operator/systemd/`:

```bash
sudo cp docs/operator/systemd/kyberion-agent-runtime-supervisor.service /etc/systemd/system/
sudo cp docs/operator/systemd/kyberion-chronos.service /etc/systemd/system/
sudo cp docs/operator/systemd/kyberion-daemon-watchdog.service /etc/systemd/system/
sudo cp docs/operator/systemd/kyberion-daemon-watchdog.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now kyberion-agent-runtime-supervisor
sudo systemctl enable --now kyberion-chronos
sudo systemctl enable --now kyberion-daemon-watchdog.timer
```

```bash
sudo journalctl -u kyberion-agent-runtime-supervisor -f
sudo journalctl -u kyberion-chronos -f
sudo systemctl status kyberion-daemon-watchdog.timer
```

Edit `User`, `KYBERION_CUSTOMER`, `EnvironmentFile`, and the `pnpm` executable path
before installing if the defaults do not match the target host. `%h/kyberion` resolves
the selected service user's home directory. Repeat the same
pattern for `mission:orchestrator` if needed.

### 2.5 Verify

```bash
sudo -iu kyberion
cd ~/kyberion
pnpm kyberion doctor
```

## Windows Workstation

For: Windows operators and developers using PowerShell with the Windows Package Manager (`winget`). The schedule actuator stores and fires declarations on Windows, but Kyberion does not currently provide a Windows service installer for the unattended Chronos daemon; run it under an operator-managed service host if persistent execution is required. The ADF Replay Chrome Native Messaging host installer supports macOS and Linux only; it is not currently available on Windows.

### Prerequisites

Run these commands in PowerShell. The `--exact` and `--source winget` flags keep package resolution deterministic.

```powershell
winget install --id OpenJS.NodeJS.LTS --exact --source winget --accept-source-agreements --accept-package-agreements
winget install --id pnpm.pnpm --exact --source winget --accept-source-agreements --accept-package-agreements
winget install --id Git.Git --exact --source winget --accept-source-agreements --accept-package-agreements
```

Open a new PowerShell session after installation, then verify the required floors:

```powershell
node --version       # must be >= 24.0.0
pnpm --version       # workspace packageManager: pnpm@11.15.1
git --version
```

### Install and configure

```powershell
git clone https://github.com/famaoai-creator/kyberion.git
Set-Location kyberion
pnpm install --frozen-lockfile
pnpm build
pnpm surfaces reconcile
pnpm onboarding
```

For tenant-bound work, do not start a mission immediately after `pnpm onboarding`; follow [the standard onboarding flow](../../knowledge/product/governance/onboarding-flow.md) and pass the activation gate first.

The same setup is available through the governed environment manifests. Use a dry run first, then apply operator-confirmed installs when a tool is missing:

```powershell
pnpm env:bootstrap --manifest kyberion-toolchain
pnpm env:bootstrap --manifest kyberion-toolchain
pnpm env:bootstrap --manifest kyberion-toolchain --apply --force
```

### Verify

```powershell
pnpm kyberion doctor
pnpm kyberion list --check
pnpm pipeline --input pipelines/baseline-check.json
```

Windows-native services should be managed through the existing surface commands (`pnpm surfaces status`, `pnpm surfaces repair`). Linux `systemd` and macOS `launchd` unit files do not apply on Windows.

---

## 3. Docker (slim image)

For: quickest evaluation, isolated runs, CI environments, ephemeral demo deployments.

### 3.1 Quick run (slim, when published)

```bash
# Once kyberion/playground:slim is published — TARGET FOR PHASE A-3
docker run --rm -it \
  -p 3000:3000 \
  -v $HOME/.kyberion-data:/app/active \
  ghcr.io/famaoai-creator/kyberion-playground:slim
```

This brings up a slim image with:

- Node 24 + pnpm
- Core actuators (file, network, system, secret, wisdom, orchestrator, agent)
- Cloud voice path (no Playwright, no Style-Bert-VITS2)

### 3.2 Build locally (current state)

```bash
git clone https://github.com/famaoai-creator/kyberion.git
cd kyberion
docker build -t kyberion:local .
docker run --rm -it -p 3000:3000 kyberion:local
```

The `Dockerfile` builds the full development image. A slim variant is the Phase A-3 deliverable.

### 3.3 docker-compose (development)

```bash
docker compose up
```

See `docker-compose.yml` at the repo root.

### 3.4 Persistence

Mount these volumes if you want state to survive container restarts:

| Container path            | Purpose                                |
| ------------------------- | -------------------------------------- |
| `/app/active`             | Mission state, traces, audit           |
| `/app/customer`           | Customer overlay (FDE mode, preferred) |
| `/app/knowledge/personal` | Identity fallback for single-user mode |

### 3.5 Production Docker (FDE)

For a customer-owned VM running Docker:

```bash
docker run -d \
  --name kyberion \
  --restart unless-stopped \
  -p 3000:3000 \
  -e KYBERION_CUSTOMER=customer-slug \
  -e KYBERION_REASONING_BACKEND=anthropic \
  --env-file /etc/kyberion/env \
  -v /var/lib/kyberion/active:/app/active \
  -v /var/lib/kyberion/customer:/app/customer \
  ghcr.io/famaoai-creator/kyberion-playground:full
```

---

## 4. Post-deployment Verification

After any of the three deploys above:

```bash
pnpm kyberion doctor                 # preflight: must / should / nice
pnpm kyberion list --check       # actuator capability check
pnpm pipeline --input pipelines/baseline-check.json   # full health
```

All three should pass with no `must` failures.

---

## 5. Upgrades

```bash
git fetch origin
git checkout v0.x.y         # use a tagged release, not main
pnpm install --frozen-lockfile
pnpm build

# Run any pending migrations:
ls migration/                # check what migrations apply since your last version
node migration/<script>.js   # run each one in order

# Restart services:
sudo systemctl restart kyberion-supervisor   # Linux
launchctl kickstart -k gui/$UID/com.kyberion.supervisor   # macOS

pnpm kyberion doctor                  # confirm health
```

For breaking changes, see `CHANGELOG.md` and per-major migration guides under `migration/`.

---

## 6. Rollback

```bash
git checkout v0.previous-version
pnpm install --frozen-lockfile
pnpm build

# If the new version added schema changes, run the inverse migration:
node migration/<script>.js --rollback

# Restart services.
```

Mission state is forward-compatible by design (additive fields only). If a major bump was breaking, the inverse migration will reflect that.

---

## 7. Troubleshooting

| Symptom                                           | Likely cause                     | Action                                                                                                                                                           |
| ------------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm kyberion doctor` reports Playwright missing | browser-actuator dependency      | `pnpm env:bootstrap --manifest meeting-participation-runtime --apply --force`                                                                                    |
| `pnpm onboarding` says "no reasoning backend"     | No CLI/API key configured        | Set `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY` (or `KYBERION_OPENROUTER_KEY`), `KYBERION_NEMOTRON_URL`, `KYBERION_LOCAL_LLM_URL`, or run `claude` to authenticate |
| Mission stuck in `active` after process crash     | Stale lock                       | Lock has PID-based stale detection; next command auto-recovers                                                                                                   |
| `Trace persisted path` empty in pipeline output   | Persistence policy denied        | Check `KYBERION_PERSONA` and `MISSION_ROLE` env vars                                                                                                             |
| Customer overlay not picked up                    | `KYBERION_CUSTOMER` not exported | `echo $KYBERION_CUSTOMER` — must show your slug                                                                                                                  |
| Voice surface silent                              | OS TTS not installed             | Linux: `sudo apt-get install espeak`. macOS: built-in. Windows: built-in (SAPI)                                                                                  |

---

## 8. Decommission

```bash
# Stop services
sudo systemctl stop kyberion-supervisor   # Linux
launchctl unload ~/Library/LaunchAgents/com.kyberion.supervisor.plist   # macOS

# If FDE engagement is ending, export customer data first:
KYBERION_BACKUP_PASSPHRASE='store-outside-the-archive' \
  pnpm backup create --scope tenant --tenant customer-slug --out /path/to/export.tar.gz.enc --encrypt
# Compatibility entrypoint:
KYBERION_BACKUP_PASSPHRASE='store-outside-the-archive' \
  node --import ./scripts/ts-loader.mjs scripts/tenant_export.ts --customer customer-slug --out /path/to/export.tar.gz.enc

# Remove state:
rm -rf active/ knowledge/personal/ customer/customer-slug/
# Or, more conservatively:
tar czf /backup/kyberion-active-$(date +%F).tar.gz active/
```

## 9. Backup and Disaster Recovery

Kyberion state that is intentionally outside git must be backed up before
decommissioning, host migration, or dependency patch automation. Store the
backup passphrase once in the OS keychain through the secret actuator (hidden
prompt; the value never touches argv, a plist or a repo file), then run
backups without it on the command line:

```bash
pnpm kyberion secret introduce kyberion-backup PASSPHRASE
pnpm backup create --scope all --out /Volumes/backup/kyberion-$(date +%F).tar.gz.enc --encrypt
```

Keep an offline copy of the same passphrase in your password manager: the
keychain entry lives on this host only, and a disaster-recovery restore on a
new machine needs it from somewhere else.

Use an external volume or remote destination for real DR. A path under the same
disk is acceptable for local restore drills only; the command warns when source
and destination appear to share a device.

What `--scope all` archives: `active/`, `vault/`, `knowledge/personal/` and
`knowledge/confidential/`, minus re-creatable data — the
`active/shared/{tmp,staging,cache}` floors, every
`storage-retention-catalog.json` entry marked `"backup": "exclude"` (fully
regenerable data such as indexes, probe caches and test-run fixtures; a
`cache`/`tmp` class alone never excludes, because staging stores like distill
candidates or queued events hold pending state), the backup output directory and earlier archives in it, and the managed tool-runtime
installs (only each runtime's `state.json` provenance is kept; reinstall the
rest with `pnpm tool:setup`). Sockets, FIFOs, devices and symlinks are skipped,
mission `.git` directories ride as git bundles, and the manifest records
`excluded_roots`. A mission whose bundle cannot be created (for example macOS
denying the daemon access to `.git/config`) is reported as a warning; its
working-tree files are still archived. The tar timeout scales with the
selected size (10 min + 1 s per 4 MiB, capped at 6 h).

The passphrase is resolved in this order:

1. `--passphrase-env <NAME>` — that variable only; if it is empty the run fails
   instead of falling back.
2. `KYBERION_BACKUP_PASSPHRASE` in the running process — a manual override.
3. The secret identity `kyberion-backup` / `PASSPHRASE`: an external resolver
   (`KYBERION_SECRET_RESOLVER_COMMAND`) or the OS keychain (service
   `kyberion-backup`, account `passphrase`).

The secret must live outside the repository. `vault/` and
`knowledge/personal/` are archived, so a copy held only in an in-repo store
(`vault/secrets/*.json`, or the `knowledge/personal/connections/kyberion-backup.json`
document without a keychain entry) is refused with
`[BACKUP_PASSPHRASE_IN_BACKUP_SCOPE]`. The connection document that
`secret introduce` writes next to the keychain entry is excluded from every
archive. Each run audits the source (`env` or `secret:<backend>`), never the
value. Without any source the run fails immediately with
`[BACKUP_PASSPHRASE_MISSING]`, naming the `secret introduce` command.

The scheduled `backup-daily` job needs no passphrase in the daemon's
environment: the chronos launchd agent runs in your GUI login session, so it
can read the login keychain. Do not put the passphrase in the launchd plist's
`EnvironmentVariables`: the installer refuses to forward it
(`[POLICY_VIOLATION]`), and `pnpm kyberion scheduler reconcile` rewrites the
plist carrying only the forwardable chronos variables, so a hand-added value
is dropped on the next reconcile. On a
host without a keychain (Linux, Windows services), configure an external
resolver or set `KYBERION_BACKUP_PASSPHRASE` in the service manager's secret
mechanism (systemd `LoadCredential=`/`EnvironmentFile=` outside the checkout).

Restore into a clean Kyberion checkout or staging root:

```bash
# Same host (keychain holds the passphrase):
pnpm backup restore /Volumes/backup/kyberion-2026-07-04.tar.gz.enc --target /path/to/clean/kyberion --verify-baseline
# New host: introduce the passphrase from your password manager first, or override once:
KYBERION_BACKUP_PASSPHRASE='from-your-password-manager' \
  pnpm backup restore /Volumes/backup/kyberion-2026-07-04.tar.gz.enc --target /path/to/clean/kyberion --verify-baseline
```

For a tenant export, repeat the scope and tenant explicitly during restore so
the archive boundary is checked before extraction:

```bash
pnpm backup restore /Volumes/backup/tenant-acme.tar.gz.enc \
    --scope tenant --tenant acme --target /path/to/clean/kyberion
```

A tenant archive carries the tenant's partition of every registered runtime
root (`active/shared/runtime/<root>/<tier>/<tenant>/`: the hybrid-ledger
partition, approval store, usage and execution-metrics ledgers, and the
partitioned state roots). The manifest lists them under
`tenant_runtime_partitions` and records the audit chain key id
(`chain_key_id`), never the key itself. On restore:

- The restore target must lie inside the checkout running the command
  (`[BACKUP_RESTORE_TARGET_OUTSIDE_REPOSITORY]`); to restore a clean checkout,
  run `pnpm backup restore` from that checkout with `--target .`.
- Archives with symlink or hard-link members are refused before extraction
  (`[BACKUP_ARCHIVE_MEMBER_TYPE]`); a backup skips a symlinked partition
  directory with a warning.
- The restore refuses (`[BACKUP_RESTORE_APPEND_ONLY_CONFLICT]`, before
  extraction) when the target already holds files in an append-only partition
  the archive carries: an older snapshot over a longer live chain would be an
  undetectable rollback. Restore into an empty target and reconcile there.
  This check is the rollback guard: a hash chain has no head anchor, so a
  chain cut short at an earlier entry still verifies.
- A `--force` restore into a live checkout requires every Kyberion service
  and daemon to be stopped first: the restore's checks cannot tell a live
  writer's change from its own extraction.
- The check covers tenant partitions only. An `all`-scope `--force` restore
  over a live checkout can still roll back the system ledger
  (`active/audit/system-ledger.jsonl`), the `<tier>/shared` partitions and
  mission evidence ledgers; restore `all` scope into an empty target. An
  `all`-scope restore does not quarantine grants or invites: re-run every
  grant and invite revocation made after the backup was taken.
- Append-only partitions (and, for a tenant restore, invites and grants) are
  never extracted in place: they are extracted into a staging directory
  first. A torn last line (one that does not parse as JSON) of a staged
  `.jsonl` ledger is trimmed back to its last newline; a complete last record
  without a trailing newline is kept. The output lists `trimmed_tails`.
- Staged tenant-ledger chains are verified before anything reaches the target
  when the target host holds the same audit chain key
  (`ledger_verification: verified`). Every entry must be HMAC-chained
  (`chain_alg: hmac-sha256`) under the manifest's `chain_key_id`; an
  unkeyed or downgraded entry (`[BACKUP_RESTORE_LEDGER_DOWNGRADED]`) or a
  broken chain (`[BACKUP_RESTORE_LEDGER_CORRUPT]`) fails the restore with the
  target untouched. Otherwise the output reports `deferred_key_mismatch`: set
  `KYBERION_AUDIT_CHAIN_KEY` to the source host's key (its id is in the
  manifest) and run `pnpm audit:verify` in the restored checkout.
- The archive's customer decision invites and standing grants go straight into
  `<partition>/.restore-quarantine/<restore-id>/`; live records in the
  partition are left untouched, so state revoked after the backup cannot come
  back and records issued since are kept. Re-issue what is still due.

Tenant restores also quarantine peer messaging, conversation, and Mesh Hub
runtime state. Run the following from the restored checkout only after re-enrolling the
peer and confirming a fresh healthy heartbeat. The request creates a human
approval record; it does not resume runtime by itself:

```bash
pnpm peer:runtime-recovery request \
  --tenant-id acme \
  --quarantine-path active/shared/runtime/peer-recovery-quarantine/tenants/acme/<restore-id> \
  --requested-by <operator>
pnpm kyberion approve <approval-id> peer-recovery
pnpm peer:runtime-recovery resume \
  --tenant-id acme \
  --quarantine-path active/shared/runtime/peer-recovery-quarantine/tenants/acme/<restore-id> \
  --approval-id <approval-id>
```

If a pre-tenant migration checkout still contains flat peer/Mesh records, use
the dry-run plan first and review its manifest. Records without an explicit
valid tenant are quarantined rather than guessed:

```bash
pnpm peer:migrate-tenant-runtime
pnpm peer:migrate-tenant-runtime -- --plan active/shared/runtime/migrations/peer-tenant/manifests/<migration-id>.json --apply
```

Backups containing `vault/`, `knowledge/confidential/`, or confidential
mission/project state must remain encrypted. Do not store
`KYBERION_BACKUP_PASSPHRASE`, audit-chain keys, or SaaS auth encryption keys in
the archive itself; keep the backup passphrase in the OS keychain (via
`secret introduce`) with an offline copy in the operator password manager, and
the other keys in the password manager or hardware key escrow. The scheduled job definition is `pipelines/backup-daily.json` and uses
the same `pnpm backup create --scope all --encrypt` command.

---

## See Also

- [`docs/QUICKSTART.md`](../QUICKSTART.md) — developer-oriented setup.
- [`docs/developer/CUSTOMER_AGGREGATION.md`](../developer/CUSTOMER_AGGREGATION.md) — FDE customization model.
- [`docs/developer/EXTENSION_POINTS.md`](../developer/EXTENSION_POINTS.md) — what's stable vs internal.
- [`docs/PRIVACY.md`](../PRIVACY.md) — what data flows where.
