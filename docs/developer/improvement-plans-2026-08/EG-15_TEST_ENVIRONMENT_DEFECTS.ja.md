# EG-15: テストが落ちていた 2 つの環境要因

> **記録日**: 2026-08-12
> **発見元**: ミッション `MSN-ORG-FOUNDATION-20260812`。棚卸しの過程で「既知の失敗」として何度も見送っていた 9 件を診断した
> **位置づけ**: [EG-14](./EG-14_TIER_NAME_AS_TENANT_SLUG.ja.md) の隣。EG-14 が「tier と tenant の軸の混線」なら、こちらは「テスト環境と実環境の混線」
> **状態**: 両方対処済み

長らく「環境依存の既知の失敗」として扱っていた 9 件を診断した。**片方はテストの問題ではなく機能が動いていない証拠**であり、もう片方はテスト設計の問題だった。

---

## ① sqlite `trusted_schema=0` — 6 件（機能が動いていなかった）

### 症状

`libs/core/history-search-index.test.ts` 5 件と `libs/actuators/wisdom-actuator/src/index.test.ts` 1 件が
`history search sqlite failed: Parse error near line 2: unsafe use of virtual table "history_fts"` で失敗。

### 原因

Apple 同梱の sqlite3（3.43.2）は `trusted_schema=0` が既定。この設定下では **FTS5 仮想テーブルをトリガの本体で使えない**。`history-search-index.ts` は FTS を 3 つのトリガで同期している:

```sql
CREATE TRIGGER history_entries_ai AFTER INSERT ON history_entries BEGIN
  INSERT INTO history_fts(rowid, content) VALUES (new.rowid, new.content);
END;
```

最小再現:

```
$ sqlite3 t.db "CREATE TABLE e(content TEXT); CREATE VIRTUAL TABLE f USING fts5(content);
                CREATE TRIGGER e_ai AFTER INSERT ON e BEGIN INSERT INTO f ...; END;
                INSERT INTO e VALUES('hello');"
Error: in prepare, unsafe use of virtual table "f"

$ sqlite3 t2.db "PRAGMA trusted_schema=ON; (同じ SQL) SELECT count(*) FROM f;"
1
```

### これはテストの問題ではない

**書き込みが通らないので、macOS 上では履歴検索機能そのものが一切動いていなかった。** Linux ディストリの sqlite3 は多くが許容側の既定でビルドされるため CI では顕在化せず、「環境依存のテスト失敗」として片付けられていた。テストは正しく機能の不在を報告していた。

### 対処

`runSql()` が唯一の SQL 投入口なので、そこで `PRAGMA trusted_schema=ON;` を前置した。pragma は接続単位で、CLI 呼び出しごとに新しい接続が開くため、スキーマ作成時に一度ではなく**毎バッチの先頭**に必要。

**緩めた保護の範囲**: `trusted_schema=0` は「他者が置いた DB ファイルのスキーマに仕込まれた仮想テーブル/関数呼び出し」への防御。今回対象の DB は `active/` 配下に自前で作り、スキーマも全て自前で書いている。ここに細工できる攻撃者は既にリポジトリへの書き込み権を持つ。

**代替案（未採用）**: `better-sqlite3` を同梱して CLI 依存を排する。環境差が根本から消えるが、ネイティブ依存が増える。長期的にはこちらが筋。

### 回帰テスト

プラットフォームに依存せず条件を直接確かめる形にした: `trusted_schema=OFF` で同じスキーマが拒否されることを確認し、拒否された環境でのみ `ON` を前置すれば通ることを検証する。許容側のビルドでは早期 return する。

**実装中に自分の書いたテストで気づいた点**: 最初の版は SQL 文字列に `PRAGMA trusted_schema=OFF;` を含めたまま 2 回目にも再利用しており、前置した `ON` を打ち消していた。スキーマ SQL と pragma を分離して解決。

---

## ② `check_catalog_integrity` — 3 件（テスト設計）

### 症状

単独実行では 4/4 通るが、`vitest run libs scripts` では 3 件が落ちる。落ちる組み合わせは実行ごとに変わる。

### 原因

このテストは **実リポジトリのファイルを書き換えて** drift を注入していた（`knowledge/public/design-patterns/media-templates/themes.json` と `knowledge/product/orchestration/user-facing-vocabulary.json`）。注入 → チェッカーを子プロセスで実行 → `afterEach` で復元。

`describe.sequential` はファイル**内**の直列化にすぎず、vitest はファイル**間**を並列実行する。結果、干渉が双方向に起きていた:

- **出ていく方向**: catalog を意図的に壊している最中に、別ファイルのテストがそれを読む
- **入ってくる方向**: 別テストが `knowledge/` に残した一時ファイルで knowledge manifest が stale になり、チェッカーが**このテストが注入していない違反**を報告する。「どの違反が出るか」を assert しているので落ちる

### 対処

検証ロジックを**データを受け取る純関数**として切り出した。同じディレクトリの `check_mission_gate_docs.ts` が既に採っている形（`collectMissionGateDocViolations(documents)`）。

| 純関数                                                                                 | 検証内容                                                                          |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `collectThemeCatalogViolations({label, catalog, expectedThemes, isRootThemesCatalog})` | 生成トークンとテーマ catalog の一致、`default_theme`                              |
| `collectVocabularyCatalogViolations(data)`                                             | required locale の網羅、locale 間のプレースホルダ一致、`default_locale` の所属    |
| `collectUndefinedKeyReferenceViolations(sources, resolveKey?)`                         | コード→catalog の前方参照。`sources` はラベル→本文の写像、`resolveKey` は注入可能 |

`main()` は薄い I/O ラッパになり、これらを呼ぶだけ。あわせて `main()` を直接実行時のみ走るようガードした（純関数を import しただけでリポジトリ全体チェックが走らないように）。

テストは 4 件 → **11 件**になった。fixture を渡すだけなので共有状態を触らず、以前は書きにくかったケース（プレースホルダ不一致、`default_locale` の所属、`t()` を `scripts/cli.ts` 以外で読まないこと、曖昧キーのエラー伝播）も追加できた。

### smoke test は残さず、CI に委ねた（当初案からの変更）

当初は「今のリポジトリが実際に綺麗である」ことを実物でしか主張できないと考え、`retry: 2` 付きの smoke test を 1 本残す方針だった。**が、それでもまだ落ちた。**

調べると `knowledge/` に書き込むテストは **36 ファイル**あり、いずれも正当な fixture 作成である。つまりこの assertion は並列実行中の**一時的な churn を測っている**のであって、リポジトリの状態を測れていない。リトライ回数を増やしても構造的に解決しない。

主張が成立する場所へ移した:

- CI が `pnpm run check:catalogs` を**独立した直列ステップ**として実行している（`.github/workflows/ci.yml` の "Check knowledge catalogs & index freshness"）
- `pnpm validate` にも含まれている

カバレッジを落としたのではなく、**成立しない場所から成立する場所へ移した**。並列テスト内でグローバル状態を assert するのは、そもそも間違った置き場所だった。

---

## 両者に共通していたこと

どちらも「環境依存の既知の失敗」として長く放置されていたが、中身は別物だった。

- ① は**テストが正しく機能の不在を報告していた**。失敗を環境のせいにしていた分だけ、macOS 上で履歴検索が動いていないことに気づけなかった
- ② は**テストが共有状態を壊していた**。原因はテスト側にあり、機能は正しかった

「環境依存」というラベルは、この 2 つを区別せずに覆い隠す。落ちているテストは、どちらなのかを判定するまで既知として扱わないほうがよい。
