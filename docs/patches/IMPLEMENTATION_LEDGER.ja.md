# 実装台帳 — improvement-plans-2026-07 の実装記録

> **開始**: 2026-07-03 / 実装者: Fable 5
> **配信方式**: 社用端末制約により PR は作らず、変更は作業ツリーに反映し `docs/patches/*.patch` として受け渡す。confidential 漏洩スキャンを各パッチ生成前に実施。
> **方針**: 依存順(Wave 1 の P0 基盤から)。1 計画ごとに 実装 → 検証(build/lint/test)→ パッチ化。判断が必要で止める箇所は、そこまでを反映したパッチを残し、本台帳に「未了・理由・方針」を記録する。

## 進捗

| 計画                          | 状態           | 検証                                             | パッチ     | 備考                                                                                                                                          |
| ----------------------------- | -------------- | ------------------------------------------------ | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| IP-01 ESLint ガバナンス実効化 | 実装済(検証中) | eslint 単体で enforcement 確認・pnpm lint 実行中 | (生成予定) | ban は fs/node:fs に限定(child_process は core に30+の正当 spawn があるため別作業)。9件の既知 fs 違反は IP-02 参照の抑制コメントで green 維持 |

## 判断記録(スコープの明確化)

- **IP-01 の child_process 除外**: AGENTS.md §1 の不変条件は「ファイル I/O は secure-io、node:fs を直接呼ばない」。libs/core には PTY・ストリーミング音声・CLI バックエンド等で長寿命/ストリーミング `spawn` を使う正当なモジュールが 30 以上あり、safeExec(一発実行)では代替不可。よって IP-01 の ban は **fs/node:fs に限定**し、child_process→safeExec 統制は別途の大規模計画に切り出す(本台帳に別項目として追記予定)。
- **IP-01 と IP-02 の分担**: IP-01 は「enforcement を効かせ、新規の fs 直 import を防ぐ」まで。既存の 9 件の fs 直 import(native engine ×5 + mlx-embedding-backend + scripts 3件)は IP-02(secure-io 実移行、文書生成への影響検証が必要)で修正する。それまでは IP-02 参照の `eslint-disable-next-line` で抑制。
- **tests/** の据え置き**: tests は setup で fs を多用(約40ファイル)。un-ignore すると大量の抑制が必要になり CI ゲートを乱すため、tests は ignore 継続(fs 不変条件の enforcement 対象外)。tools/** も拡張・静的アセットのため据え置き。
