# UI/UX・デザインシステム持続運営計画 2026-07-13

> 対象: Kyberion 全体の UI/UX、Web surface、共有語彙、デザイントークン
> 上位正本: [STATUS.ja.md](./STATUS.ja.md)
> 関連計画: [DS-01](./DS-01_CANONICAL_DESIGN_TOKENS.ja.md)、[UX-05](./UX-05_UX_CONTRACT_ENFORCEMENT.ja.md)、[AO-01](./AO-01_AUTONOMOUS_MAINTENANCE_LOOP.ja.md)

## 1. 俯瞰結果

最新 `origin/main` を基準に、Chronos Mirror、operator-surface、Presence Studio、computer-surface、CLI/dashboard、共有 UX 契約、CI/pipeline を突合した。

主要な構造は既に整っている。正準トークン JSON、4面への generator、共有 `renderStatus()`、surface UX validator、a11y gate は実装済みだった。一方、持続運営を妨げる残差は次の3点に集約できた。

1. 正準 JSON に semantic token があるのに CSS/Tailwind generator が出力せず、operator-surface に約100箇所の色 literal が残っていた。
2. `--kb-border` が面によって「色」と「border shorthand」の両方として扱われ、明示テーマ切替時に意味が変わっていた。
3. dashboard の状態表示と UI/UX drift は、共有語彙や定期監査を迂回しても CI が検知できなかった。

## 2. 改善方針

### Wave 1 — canonical 化を閉じる（実装済み）

- semantic token (`accent-text / surface / muted-text / border / success / danger`) を light/dark と明示テーマ selector へ生成する。
- operator-surface の raw HEX/RGB を semantic `--kb-*` token へ置換する。
- `--kb-border` を色トークンとして統一し、border width/style は consumer 側で宣言する。

### Wave 2 — UX 契約を gate 化する（実装済み）

- connection/provider/mission/runtime の共有状態語彙を補完する。
- sovereign dashboard の状態表示を `renderStatus()` 経由へ統一する。
- operator packet の representative fixture を `validateSurfaceUxContract()` に通す CI test を追加する。

### Wave 3 — 自律的な持続運営（実装済み）

- `pnpm check:ui-ux` を `pnpm validate` と GitHub Actions に接続する。
- `pipelines/ui-ux-governance-audit.json` を毎週月曜 07:30 JST に実行する。
- audit owner を `design-system-steward` とし、違反時の next action を機械可読で返す。
- 最新 main で陳腐化していた type-ratchet baseline を、今回差分が `any` / `as any` を増やしていないことを確認して再同期する。併せて、既存 baseline を更新できなかった `--write-baseline` の実装を修復する。

## 3. 運営契約

| 項目     | 契約                                                                                |
| -------- | ----------------------------------------------------------------------------------- |
| 正本     | `knowledge/public/design-patterns/brand-tokens/kyberion.json`                       |
| 生成     | `node --import ./scripts/ts-loader.mjs scripts/generate_design_tokens.ts`           |
| PR gate  | `pnpm check:ui-ux` と `pnpm check:catalogs`                                         |
| 定期監査 | `ui-ux-governance-weekly`                                                           |
| owner    | `design-system-steward`                                                             |
| SLO      | main 上の raw operator color / missing semantic token / status bypass を 0 件に保つ |
| 修復順   | generator 再実行 → semantic token 置換 → `renderStatus()` 配線 → targeted test      |

## 4. 次の改善候補

今回の完了条件から意図的に分離する。

- DS-04: motion/transition token の正準化。
- UX-04: Slack proposal の Block Kit button 化。
- AO-04: 30日連続運用 evidence の蓄積。
- visual regression: browser screenshot の light/dark/tenant theme 比較を、安定した fixture が揃った段階で週次 audit に追加する。

## 5. 完了条件

- operator-surface の component/page source に raw HEX/RGB がない。
- 4面の generated token CSS に semantic token がある。
- dashboard の代表状態が共有語彙を使う。
- representative operator output が UX contract を通る。
- audit pipeline、validate、CI の3経路が同じ drift を検出する。
