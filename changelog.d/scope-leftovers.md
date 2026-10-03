---
category: Fixed
---

- **スコープ統制の積み残しを解消** — 観測の tier を観測リソースのパスから引き上げ、observation 初回の監査、journal refresh 失敗の一度きり監査、隔離 held action の人間承認による引き取り（`adoptQuarantinedHeldAction`、tombstone 付き）、旧状態の共通 fold、所有 mission を解決できない workspace の報告（`gc --apply --include-unresolvable-owners` で 3x TTL 後に回収。tenant 束縛プロセスからは拒否）。
