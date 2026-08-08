# QM-02 retrospective

## 成功

- exact-once、retry、authority、scheduler、watch lifecycle を契約テストで具体化できた。
- audit failure を side effect failure と混同しない境界を追加できた。

## 失敗・改善点

- 初回実装では read-then-append、failed permanent dedupe、scope level の audit 回帰を見逃した。
- 次回は並行 claim、authority derivation、failed retry、audit failure の4軸を先に検証する。

## knowledge昇格候補

- trigger idempotency store の claim/lease/retry パターン
- canonical authority scope と execution-role binding のレビュー観点
