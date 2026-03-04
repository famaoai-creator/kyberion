# SOP: Unit Test Modernization & Alias Integrity

大規模なテストスイートをレガシー（.cjs）から TypeScript/Vitest へ移行する際の標準手順と、多層的なエイリアス管理の規律。

## 1. 多層的エイリアス整合性 (The Multi-Layer Alias Rule)
モノレポにおいて `@agent/core` などのエイリアスは、単一の定義では不十分である。
- **TSC Layer**: `tsconfig.json` の `paths` で定義（ビルド用）。
- **Vitest Layer**: `vitest.config.ts` の `alias` で定義（テスト実行用）。
- **Runtime Layer**: `node_modules` のシンボリックリンクで解決（本番実行用）。
- **規律**: 1つのエイリアスを変更したら、必ず上記3層すべての整合性を物理的に確認すること。特に Vitest では正規表現を用いたサブパス解決 (`/^@agent\/core\/(.*)$/`) が必須となる。

## 2. 外科的移行手順 (Surgical Migration Protocol)
数万行に及ぶレガシーテストを移行する際、一括変換はシステム限界（V8クラッシュ等）を招く。
- **Action**: Monolithic なテストファイルから機能ごとに `.test.ts` を切り出し、一つずつ `npx vitest run` を通す。
- **Discovery**: 移行中にソースコード側の「欠落した仕様（例：validateUrl 等）」を発見した場合は、即座に TypeScript 側へ再実装し、型定義を最新化する。

## 3. 依存関係の断捨離
- **Action**: テスト移行完了後、不要となった `harness.cjs` や `.test.cjs` を物理的に削除する。
- **Validation**: `package.json` の `scripts` を Vitest 起点に書き換え、`npm test` がモダンな環境で走ることを保証する。

## 4. トラブルシューティング：Abort trap (V8 Crash)
テスト実行中に致命的なクラッシュが発生した場合：
- [ ] 循環参照が発生していないか？（`index.ts` 経由のインポートを見直す）
- [ ] エイリアスがディレクトリではなくファイルを指していないか？
- [ ] 移行対象を細分化し、メモリ負荷を軽減しているか？
