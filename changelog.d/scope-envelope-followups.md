---
category: Fixed
---

- **スコープ封筒の残課題 3 点** — (1) claim 後に結果が記録されない held effect を、認証済み人間が `releaseApplyClaim` で解放できるように（`applyClaim` を operator summary にも表示）。(2) egress ガードが呼び出し元の audience/tenant/hash を一切読まず、manifest の `egress_destination_from` が指す実際の宛先ホストを egress ポリシー（`classifyEgressDestination`）で分類して判定するように。(3) manifest の `step_ops` で `system:write_file` / `browser:goto` などパイプラインのステップ op の effect・resource_ref・宛先を宣言可能に（pipelines 内の op 利用の解決率 13% → 51%）。read の observation が大量に記録されるため、journal の追記ごとの全体パースと、observation ごとの snapshot/rollup 全量書き直しを廃止（1,000 件記録のコストが線形化）。
