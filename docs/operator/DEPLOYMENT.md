---
title: Kyberion Deployment Runbook
category: Operator
tags: [deployment, install, runbook, fde]
importance: 9
last_updated: 2026-05-07
---

# Kyberion Deployment Runbook

How to deploy Kyberion in three reference environments. This is the document an FDE engineer or operator follows when standing up a customer or self-hosted instance.

For development setup, see [`../QUICKSTART.md`](../QUICKSTART.md). This document is for **operational deployment**: machines that will run Kyberion in service, not just developer workstations.

## 0. Pre-deployment Checklist

Before installing on any environment:

- [ ] Decide single-user vs. customer-overlay (FDE) mode. Customer-overlay = define `KYBERION_CUSTOMER` and prepare `customer/{slug}/`.
- [ ] Decide reasoning backend: `claude-cli` (preferred when CLI is authenticated), `anthropic` (API key), `codex-cli`, `gemini-cli`, or `stub` (offline).
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
brew install node@22 pnpm git
node --version   # must be >= 22.0.0
pnpm --version   # must be >= 10.x

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
pnpm surfaces:reconcile     # bring up background surfaces
pnpm onboard                # interactive identity setup → knowledge/personal/
```

### 1.4 Configure (FDE / customer overlay)

```bash
pnpm customer:create customer-slug
$EDITOR customer/customer-slug/customer.json
$EDITOR customer/customer-slug/identity.json
$EDITOR customer/customer-slug/vision.md

pnpm customer:switch customer-slug
source active/shared/runtime/customer.env
pnpm onboard
```

### 1.5 Verify

```bash
pnpm doctor                 # preflight: must, should, nice
pnpm dashboard              # visual status
```

### 1.6 Run

For interactive use:

```bash
pnpm chronos:dev            # opens browser surface at http://127.0.0.1:3000
```

For background services:

```bash
pnpm agent-runtime:supervisor   # in one terminal (or use a launchd plist)
pnpm mission:orchestrator       # in another
```

### 1.7 Production launchd (optional)

If Kyberion should auto-start on login, install a launchd plist:

```bash
# Sample plist lives at:
#   docs/operator/macos/com.kyberion.supervisor.plist (TODO: ship this template)
# After copying to ~/Library/LaunchAgents/ and editing paths:
launchctl load -w ~/Library/LaunchAgents/com.kyberion.supervisor.plist
```

---

## 2. Linux Server (Ubuntu 22.04 / 24.04)

For: customer-controlled VMs, internal infrastructure, persistent always-on Kyberion instances.

### 2.1 Prerequisites

```bash
# Required
sudo apt-get update
sudo apt-get install -y curl git build-essential
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npm install -g pnpm@10

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

1. **`pass` + GPG** — GNU password store, supported by `secret-actuator` if configured.
2. **systemd `LoadCredential=`** — encrypted secrets at unit startup.
3. **`customer/{slug}/secrets.json`** — only if the file is on an encrypted volume and accessible to the kyberion user only (`chmod 600`).

For production, prefer option 1 or 2.

### 2.4 systemd unit

Create `/etc/systemd/system/kyberion-supervisor.service`:

```ini
[Unit]
Description=Kyberion Agent Runtime Supervisor
After=network.target

[Service]
Type=simple
User=kyberion
WorkingDirectory=/home/kyberion/kyberion
Environment=NODE_ENV=production
Environment=KYBERION_CUSTOMER=customer-slug
EnvironmentFile=-/etc/kyberion/env
ExecStart=/usr/bin/pnpm agent-runtime:supervisor
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now kyberion-supervisor
sudo journalctl -u kyberion-supervisor -f
```

Repeat for `mission:orchestrator` if needed.

### 2.5 Verify

```bash
sudo -iu kyberion
cd ~/kyberion
pnpm doctor
```

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
- Node 22 + pnpm
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

| Container path | Purpose |
|---|---|
| `/app/active` | Mission state, traces, audit |
| `/app/knowledge/personal` | Identity (single-user mode) |
| `/app/customer` | Customer overlay (FDE mode) |

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
pnpm doctor                 # preflight: must / should / nice
pnpm cli list --check       # actuator capability check
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

pnpm doctor                  # confirm health
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

| Symptom | Likely cause | Action |
|---|---|---|
| `pnpm doctor` reports Playwright missing | browser-actuator dependency | `pnpm exec playwright install chromium` |
| `pnpm onboard` says "no reasoning backend" | No CLI/API key configured | Set `ANTHROPIC_API_KEY`, or run `claude` to authenticate |
| Mission stuck in `active` after process crash | Stale lock | Lock has PID-based stale detection; next command auto-recovers |
| `Trace persisted path` empty in pipeline output | Persistence policy denied | Check `KYBERION_PERSONA` and `MISSION_ROLE` env vars |
| Customer overlay not picked up | `KYBERION_CUSTOMER` not exported | `echo $KYBERION_CUSTOMER` — must show your slug |
| Voice surface silent | OS TTS not installed | Linux: `sudo apt-get install espeak`. macOS: built-in. Windows: built-in (SAPI) |

---

## 8. Decommission

```bash
# Stop services
sudo systemctl stop kyberion-supervisor   # Linux
launchctl unload ~/Library/LaunchAgents/com.kyberion.supervisor.plist   # macOS

# If FDE engagement is ending, export customer data first:
pnpm tsx scripts/tenant_export.ts --customer customer-slug --out /path/to/export.tar.gz
# (TODO: this script is a Phase C-5 deliverable from the SaaS roadmap, repurposed for FDE handoff.)

# Remove state:
rm -rf active/ knowledge/personal/ customer/customer-slug/
# Or, more conservatively:
mv active/ /backup/kyberion-active-$(date +%F).tar.gz
```

---

## See Also

- [`docs/QUICKSTART.md`](../QUICKSTART.md) — developer-oriented setup.
- [`docs/developer/CUSTOMER_AGGREGATION.md`](../developer/CUSTOMER_AGGREGATION.md) — FDE customization model.
- [`docs/developer/EXTENSION_POINTS.md`](../developer/EXTENSION_POINTS.md) — what's stable vs internal.
- [`docs/PRIVACY.md`](../PRIVACY.md) — what data flows where.
