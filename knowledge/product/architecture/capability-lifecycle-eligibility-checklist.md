# Capability Lifecycle Eligibility Checklist

Kyberion で管理する必要があるものに対して、`Capability Lifecycle Procedure` を適用するかどうかを判定するための短い基準。

## 判定ルール

次の 3 項目のうち **2つ以上** が `yes` なら、共通の lifecycle procedure の対象にする。

1. **状態があるか**
   - その対象は作成・更新・停止・廃止などの状態変化を持つか。

2. **再実行・再同期があるか**
   - 同じものを再スキャン、再起動、再登録、refresh する必要があるか。

3. **監査・証跡・承認が必要か**
   - 実行ログ、receipt、approval、owner 記録が必要か。

## 追加の確認質問

次の質問のどれかが `yes` なら、ほぼ lifecycle 管理対象とみなしてよい。

- 失敗時に fallback 先や recovery 手順があるか
- retire / disable / revoke が必要か
- 他の surface や provider と接続し、整合を保つ必要があるか
- runtime ownership を明示する必要があるか

## 判定結果

- `2つ以上 yes`
  - 共通骨格の対象
  - `discover -> normalize -> register -> activate -> observe -> refresh -> retire` を通す

- `1つ yes`
  - まずは個別実装に留める
  - ただし高リスクまたは高頻度なら部分的に共通化を検討する

- `0 yes`
  - 共通 procedure の対象外
  - 純関数、補助関数、単発変換として扱う

## 例

- `provider capability scan`
  - 状態: yes
  - 再実行: yes
  - 監査: yes
  - 判定: 対象

- `surface reconcile`
  - 状態: yes
  - 再実行: yes
  - 監査: yes
  - 判定: 対象

- `JSON の単純な整形関数`
  - 状態: no
  - 再実行: no
  - 監査: no
  - 判定: 対象外

## 関連

- [Capability Lifecycle Procedure](./capability-lifecycle-procedure.md)
- [Provider Capability Scan Framework](./provider-capability-scan-framework.md)
- [Provider Native Capability Bridge](./provider-native-capability-bridge.md)
- [Agent Runtime Observability Model](./agent-runtime-observability-model.md)
- [Execution Receipt Policy](../governance/execution-receipt-policy.json)
