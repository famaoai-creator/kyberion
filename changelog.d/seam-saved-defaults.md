---
category: Added
---

- **Saved seam defaults** — `pnpm kyberion seam select defaults set --seam <seam> --provider <id> [--tenant T] [--organization O] [--project P]` saves which provider a seam uses when a call names none and gives no purpose. Layers resolve env `KYBERION_SEAM_DEFAULTS` > project > organization > tenant > operator > policy default; eligibility still decides, and mission pins and operator rules still win. `defaults list` shows the effective default per seam and `seam select explain` reports its `default_source`. Every multi-provider seam honours it, including new governed policies for judgment, screen capture, public ingress, meeting join, email account and calendar providers. Security engines (authn/authz) opt out with `allow_saved_default: false`.
