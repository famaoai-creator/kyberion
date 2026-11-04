---
category: Added
---

- Add opt-in external secret-manager adapters on the `secret-provider` seam (`libs/core/secret/external-secret-providers.ts`): HashiCorp Vault (KV v2 over governed `secureFetch`, check-and-set writes; `KYBERION_VAULT_ADDR` + `KYBERION_VAULT_TOKEN`), and read-only AWS Secrets Manager (`KYBERION_AWS_SECRETS_PREFIX`), GCP Secret Manager (`KYBERION_GCP_SECRETS_PROJECT`) and 1Password (`KYBERION_1PASSWORD_VAULT`) via their CLIs' own auth. Each stays unavailable — and never spawns its CLI — until configured, so unconfigured hosts keep the keychain → file → env chain; once configured they take precedence in the governed chain, letting containers resolve API keys into memory without plaintext on disk.
