---
title: Antigravity CLI Multi-Account Profile Operations
category: Orchestration
tags: [orchestration, antigravity, agy, multi-account, profiles, reasoning-backend, governance]
importance: 8
last_updated: 2026-09-27
---

# Antigravity CLI Multi-Account Profile Operations

This playbook documents how to configure, switch, and operate multiple Google accounts with the Antigravity CLI (`agy`) on a single workstation, both via CLI utilities and natively within Kyberion reasoning workloads.

## 1. Background & Architecture

The standard Antigravity CLI binary stores OAuth credentials, session tokens, local conversation history, and cache directories under:

```
~/.gemini/antigravity-cli/
```

By default, `agy` does not expose an in-CLI `--profile` flag. When developers or organizations need to separate environments (such as a personal Google account and an enterprise Google Workspace / Cloud account), running both under the same home directory risks token collisions and conversational state contamination.

To provide clean, concurrent isolation without breaking developer tooling:

- **Profile Directory Isolation**: Each account profile resides at `~/.agy-profiles/<profile_name>/`.
- **Transparent Dotfile Inheritance**: Common developer configurations (`.gitconfig`, `.ssh`, `.config`, `.local`, `.zshrc`, etc.) are symlinked from the primary `$HOME` into the profile directory so standard tools (`git`, `ssh`, `node`, `pnpm`) operate identically.
- **Isolated `.gemini` Directory**: Each profile maintains its own `~/.agy-profiles/<name>/.gemini/antigravity-cli/` containing its dedicated `antigravity-oauth-token`, conversation logs, and cache. Shared read-only assets (`builtin/skills`, `bin`) are linked to conserve disk space.

```
~/.agy-profiles/work/
├── .gemini/
│   └── antigravity-cli/
│       ├── antigravity-oauth-token   <-- Isolated OAuth token for work account
│       ├── settings.json              <-- Profile-specific or inherited settings
│       ├── builtin/ -> ~/.gemini/...  <-- Linked built-in skills
│       └── bin/     -> ~/.gemini/...  <-- Linked runtime binaries
├── .gitconfig -> ~/.gitconfig         <-- Transparent dev tooling
├── .ssh       -> ~/.ssh
└── .config    -> ~/.config
```

---

## 2. Profile Management via Kyberion CLI (`pnpm kyberion agy profile`)

Kyberion integrates profile management natively via its unified CLI router without adding scripts to `package.json`:

### 2.1 Repository Commands (Available on any clone)

- **List available profiles**:
  ```bash
  pnpm kyberion agy profile list
  ```
- **Add a new profile**:
  ```bash
  pnpm kyberion agy profile add work
  ```
- **Authenticate with Google (Browser OAuth)**:
  ```bash
  pnpm kyberion agy profile login work
  ```
- **Run directly under a profile**:
  ```bash
  pnpm kyberion agy profile run work [options...]
  ```
- **Delete a profile**:
  ```bash
  pnpm kyberion agy profile delete work
  ```
- **Install host CLI shortcuts & shell functions** (creates bash/batch scripts in `~/.local/bin` and configures `.zshrc`, `.bashrc`, `.bash_profile`, or PowerShell `$PROFILE`):
  ```bash
  pnpm kyberion agy profile setup-host
  ```

### 2.2 Host Shell Shortcuts (`agyp`, `agy-use`, `agy --profile`)

Once `setup-host` has run on a workstation:

- **Direct shortcut**:
  ```bash
  # POSIX (zsh / bash) & Windows (cmd.exe / PowerShell):
  agyp work --print "Explain this codebase"
  agy --profile work [options...]
  ```
- **Terminal session switching**:
  ```bash
  # POSIX (zsh / bash) & PowerShell:
  agy-use work      # All subsequent 'agy' commands in this terminal use the 'work' profile
  agy               # Runs under 'work'
  agy-use default   # Returns to the default primary account
  ```

### 2.3 Cross-Platform & Windows Compatibility

- **macOS / Linux / WSL**: Uses POSIX symbolic links and shell functions in `.zshrc` / `.bashrc` / `.bash_profile`.
- **Windows Native (cmd / PowerShell)**:
  - Generates Windows batch wrappers (`agy-profile.cmd` and `agyp.cmd`) in `%USERPROFILE%\.local\bin`.
  - Automatically provisions directory junctions (instead of symlinks requiring Administrator privileges) for shared `.gemini` assets and user dotfiles.
  - Automatically configures PowerShell profile (`Documents\PowerShell\Microsoft.PowerShell_profile.ps1`) with PowerShell-native `agy` and `agy-use` functions.
  - Transparently sets both `HOME` and `USERPROFILE` to the profile directory when spawning child processes.

---

## 3. Kyberion Native Integration

Kyberion's reasoning backend layer natively supports profile resolution without requiring manual wrapper calls:

### 3.1 Declarative Environment Variable

Set `KYBERION_AGY_PROFILE` in your environment or repository `.env`:

```bash
export KYBERION_AGY_PROFILE=work
```

When `KYBERION_AGY_PROFILE` is configured:

1. `AgyCliBackend` resolves the target profile directory at `~/.agy-profiles/${profile}`.
2. If the directory exists, it sets `HOME` to `~/.agy-profiles/${profile}` and forwards `AGY_PROFILE` in the child process execution environment.
3. If the profile directory does not exist, it emits a structured warning and safely falls back to the default home directory.

### 3.2 Programmatic Backend Construction

When instantiating `AgyCliBackend` programmatically:

```typescript
import { AgyCliBackend } from './libs/core/agy-cli-backend.js';

const backend = new AgyCliBackend({
  agyProfile: 'work',
  model: 'Gemini 3.8 Flash (Low)',
});
```

---

## 4. Multi-Provider & Governance Guarantees

In accordance with [Multi-Provider Co-Execution Contract](../governance/multi-provider-coexecution-contract.md):

- **Egress & Credential Isolation (XP-02)**: `AGY_PROFILE` is explicitly registered in `PROVIDER_REQUIRED_ENV_KEYS.agy` and `SAFE_EXEC_ENV_ALLOWLIST`. Other providers' credentials (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc.) are stripped during delegation spawn.
- **Concurrent Co-Execution**: Different terminal sessions or parallel Kyberion mission workers can concurrently run separate AGY profiles (e.g. Worker A using `personal`, Worker B using `work`) on the same host without race conditions or credential leakage.
- **Git Index & Mission Ownership**: Regardless of the AGY account profile used, work-item claim and git ownership invariants remain strictly enforced.
