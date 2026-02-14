# スキル間データ受け渡し仕様 (Data Handover Specs)

複数のスキルが連鎖する際の情報欠落を防ぐための共通インターフェース。

## 1. 思考のバトン (Textual Handover)

全スキルの中間報告は、以下の 3部構成 を必須とする。

1. **[SUMMARY]**: 結論（何が判明したか、何が完了したか）。
2. **[CONTEXT]**: 根拠（使用したデータ、重要な制約）。
3. **[NEXT]**: 次のスキルへの指示（何をしてほしいか、どの変数に注目すべきか）。

## 2. 構造化データのバトン (JSON Specs)

スキル間で JSON を受け渡す際は、以下のメタデータを最上位階層に含める。

```json
{
  "origin_skill": "skill-name",
  "confidence_score": 0.95,
  "timestamp": "ISO-String",
  "payload": { ... }
}
```
