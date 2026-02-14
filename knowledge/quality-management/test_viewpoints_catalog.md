# Test Viewpoint Catalog: Non-Functional Excellence

## 1. Reliability (SRE Focus)

- [ ] **Retry Logic**: 一時的なエラー時に自動再試行されるか。
- [ ] **Error Code**: `error-signatures.json` に準拠した適切なコードを返しているか。
- [ ] **State Cleanliness**: 失敗時、一時ファイルが確実に削除されているか。

## 2. Performance (Engineer Focus)

- [ ] **Index Load**: `global_skill_index` の読み込みを最小限に抑えているか。
- [ ] **Memory Limit**: 200MB 以内に収まっているか（大規模データ処理時）。
- [ ] **Concurrency**: 大量ファイル処理時に `mapAsync` を使用しているか。

## 3. Security (Cyber Sec Focus)

- [ ] **Least Privilege**: `Sovereign Shield` をバイパスしていないか。
- [ ] **Secret Masking**: 秘密情報をログや出力に含めていないか。
- [ ] **Path Sanitization**: ユーザー入力をそのままファイルパスに使っていないか。
