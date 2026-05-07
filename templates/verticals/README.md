# Vertical Mission Seed Templates

Pre-built mission templates for common industry / use-case patterns. **Phase D'-2** of `docs/PRODUCTIZATION_ROADMAP.md`.

These are **starter templates** — copy one into a new mission, customize, and run. They embody the recurring shape of work in a domain so an FDE engineer doesn't start from scratch on every customer.

## Available templates

| Vertical | Use case | Path |
|---|---|---|
| Finance / Approval ops | 稟議承認の自動化 (intra ringi approval automation) | [`finance-ringi-approval/`](./finance-ringi-approval/) |
| Personal / Lifestyle | レストラン・サロン等の予約代行 | [`lifestyle-reservation/`](./lifestyle-reservation/) |
| IT / Operations | 社内 SaaS の棚卸し（ライセンス・利用者・期限） | [`it-saas-inventory/`](./it-saas-inventory/) |

Each template directory contains:

```
<vertical>/
├── README.md            — what it does, who it's for, how to customize
├── mission-seed.json    — the seed describing the mission shape
└── pipeline.json        — the ADF pipeline that the mission executes
```

## How to use a template

```bash
# 1. Decide the customer / mission scope.
export KYBERION_CUSTOMER=acme-corp

# 2. Copy the template into the customer's mission-seeds dir.
cp -R templates/verticals/finance-ringi-approval customer/acme-corp/mission-seeds/ringi-2026-q2

# 3. Customize the README inputs (URLs, selectors, approval rules).
$EDITOR customer/acme-corp/mission-seeds/ringi-2026-q2/README.md

# 4. Create a mission from the seed.
pnpm mission:create --seed customer/acme-corp/mission-seeds/ringi-2026-q2/mission-seed.json

# 5. Run.
pnpm mission start <id>
pnpm pipeline --input customer/acme-corp/mission-seeds/ringi-2026-q2/pipeline.json
```

## Authoring a new template

1. Pick a recurring use case (one that comes up across multiple customers / contexts).
2. Make the customer-specific bits explicit in the README (URLs, selectors, who approves what).
3. Use `ref` sub-pipelines for shared steps (e.g. `pipelines/fragments/intra-login.json`).
4. Add `on_error.fallback` for known failure modes — these verticals will hit production conditions.
5. Add an entry to the table above.

## Template stability

These templates are **Beta** stability (per `docs/developer/EXTENSION_POINTS.md`). Their shape will evolve. If you're shipping a customer engagement based on a template, copy it (don't reference it directly) so that future template revisions don't break your engagement.
