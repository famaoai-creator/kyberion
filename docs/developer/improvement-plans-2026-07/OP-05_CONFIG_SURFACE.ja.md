# OP-05: 設定サーフェスの一元化 — 181 個の env 変数を統べる

> 優先度: P2 / 規模: S〜M / 依存: なし / 関連: IP-13(モデルID)、多数の IP/UX/AC/SA 計画が新 env を導入するため、その受け皿

## 背景と課題

- **`KYBERION_*` env 変数が 181 個**(grep 一意カウント)、約 150+ ファイルに散在。**単一の設定サーフェス文書が無い**(`docs/*config*`/`*env*` 無し、ルートに `.env.example` 無し)。
- `.env` は各モジュールで場当たり的に `process.env` 直読み(`tool-runtime-registry.ts`、`agent-runtime-supervisor.ts`、`speech-to-text-bridge.ts` 等)、`libs/core`/`scripts` に集中ローダー(`dotenv`/`loadEnv`)が無い。
- **起動時の env 検証が部分的**: doctor(`doctor_core.ts:10-95`)はコマンド・ファイル・tier シンボリックリンク・運用メモリを確認するが、**env をスキーマ検証しない**。サブシステム別 preflight(`service_preflight.ts`、`media_runtime_preflight.ts`、`environment-doctor.ts`、`bootstrap_environment.ts`)はあるが統一 env 契約でない。
- 結果、設定ミスはサブシステムが実行時に落ちるまで**サイレント**。FDE 導入時のサポート負荷。しかも本改善計画群(IP/UX/AC/SA/OP)自体が多数の新 env(`KYBERION_A2A_SIGNATURE`、`KYBERION_SHELL_POLICY`、`KYBERION_EGRESS_POLICY`、`KYBERION_MEMORY_AUTOPROMOTE`、`KYBERION_TASK_MODEL_ROUTING` 等)を導入するため、受け皿が要る。

## ゴール(受入条件)

1. 全 `KYBERION_*` env の**正準レジストリ**(名前・用途・型・既定値・必須/任意・所属サブシステム)が 1 箇所にでき、`.env.example` と設定文書が生成される。
2. 起動時に env をレジストリに対して検証し、未知/型不正/必須欠落を doctor / 起動時に警告する(既定は warn、破壊的な誤設定は fail-fast)。
3. 新規 env 追加時にレジストリ登録を促す仕組み(CI で「レジストリ未登録の `KYBERION_*` 参照」を検出)。
4. モデルID(IP-13)・各種ポリシー閾値(SA 系)など、env でなく設定ファイルが適切なものは env から設定ファイルへ寄せる指針が示される。

## 実装タスク

### Task 1: env インベントリとレジストリ — `claude-sonnet-4`

1. `grep -rhoE 'KYBERION_[A-Z0-9_]+' libs/ scripts/ satellites/ presence/ | sort -u` で全 env を抽出し、各々の参照箇所・用途・型・既定値を棚卸しして `knowledge/product/governance/env-registry.json`(スキーマは `schemas/`)に登録する。分類(secret / path / feature-flag / tuning / provider)を付ける。
2. レジストリから `.env.example`(コメント付き)と `docs/developer/CONFIGURATION.md`(サブシステム別の env 一覧表)を**生成**するスクリプト `scripts/generate_env_docs.ts` を作る。
3. 大きいので棚卸しは分類ごとにバッチ化(secret 系 → path 系 → flag 系 …)。

### Task 2: 起動時検証 — `claude-sonnet-4`

1. `libs/core/env-validator.ts` を新設: レジストリに対して現在の env を検証(型・enum 値・必須)。`validateEnv(): { errors, warnings, unknown }`。
2. doctor(`doctor_core.ts`)と baseline-check に env 検証を追加。既定は warn(未知 env・型不正を報告)だが、**明確に破壊的な誤設定(必須シークレット欠落等)は fail-fast**。
3. 集中ローダー: `.env` 読み込みを 1 箇所(`env-validator` の初期化)に集約し、各モジュールの散在直読みは段階的にレジストリ経由アクセサ(`getEnv('KYBERION_X')`)へ寄せる(全面移行は大きいので、新規コードと本改善計画群の新 env から適用)。
4. test: 未知 env / 型不正 / 必須欠落 / 正常。

### Task 3: 再発防止と env→設定ファイル移行指針 — `claude-haiku`

1. CI(IP-03 の validate 拡張)に「レジストリ未登録の `KYBERION_*` 参照を検出」するチェックを追加。
2. `CONFIGURATION.md` に「env にすべきもの(秘密・環境固有・feature flag)vs 設定ファイルにすべきもの(ポリシー閾値・モデルID・カタログ)」の指針を記載。SA 系のポリシー閾値・IP-13 のモデルID が設定ファイル側にある理由を明記。

### Task 4: 本改善計画群の新 env 登録 — `claude-haiku`

- IP/UX/AC/KM/MO/DS/AA/SA/OP の各計画が導入する新 env(`KYBERION_A2A_SIGNATURE`、`KYBERION_SHELL_POLICY`、`KYBERION_EGRESS_POLICY`、`KYBERION_TASK_MODEL_ROUTING`、`KYBERION_MEMORY_AUTOPROMOTE`、`KYBERION_SECRET_ENCRYPTION`、`KYBERION_EMBEDDING_BACKEND` 等)を、それらの実装時に env-registry へ登録することを各計画の完了条件に含める(本計画はレジストリ基盤の提供)。

## リスクと注意

- 集中ローダーへの全面移行は 150+ ファイルに及ぶ大手術。**本計画では基盤(レジストリ + 検証 + 生成)と新規コードへの適用まで**とし、既存散在読みの全面書き換えは「継続的移行」として CI 検出で漸進する(一括はしない)。
- fail-fast の対象を誤ると起動できなくなる。fail-fast は「必須シークレット欠落」等の明白なものに限定し、それ以外は warn。
- env 検証が秘密の値をログに出さないこと(名前と有無のみ報告、値は出さない)。
