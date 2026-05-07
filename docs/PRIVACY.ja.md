# プライバシー & テレメトリ

Kyberion がデータに対して何をして、何をしないか。

## まとめ

- **デフォルトでテレメトリ無し**。明示的に opt-in しない限り、何もマシン外に出ない。
- **データはあなたのディスクに残る**。設定・ミッション・trace はローカル fs（または customer/ overlay）に保存。
- **外部 AI 呼び出しは明示的**。LLM (Anthropic / OpenAI / Gemini / Claude CLI) を使う時、リクエストはそのプロバイダに直送 — §3 参照。
- **秘密は OS keychain に**。Kyberion は `secret-actuator` 経由で OS keychain から読む。コミットされるファイルには載らない。

## 1. ローカルに保存されるもの

| パス | 内容 |
|---|---|
| `knowledge/personal/` | identity, vision, connections, voice プロファイル。**gitignored** |
| `customer/{slug}/` | FDE 顧客設定（`KYBERION_CUSTOMER` 設定時）。**gitignored**（`_template/` 除く） |
| `active/missions/{id}/` | mission ごとの git repo・state・evidence。**gitignored** |
| `active/shared/logs/traces/` | 構造化実行 trace (JSONL)。**gitignored** |
| `active/shared/runtime/` | runtime state, ロック, surface metadata。**gitignored** |
| `active/audit/*.jsonl` | 監査台帳エントリ。**gitignored** |
| `knowledge/confidential/{project}/` | プロジェクトスコープ confidential ナレッジ。**gitignored** |
| `knowledge/public/` | 公開再利用可能ナレッジ。**committed**（意図的に共有） |

`.gitignore` ポリシーは強制される。canonical list は同ファイルを参照。

## 2. デフォルトでしないこと

- ❌ Kyberion 運営サーバーへのデータ送信（そもそも存在しない）
- ❌ 匿名利用統計・クラッシュレポートの送信
- ❌ ライセンス / アクティベーションのため home に phone する
- ❌ プロジェクトルート外のファイル読み取り（`secure-io` と `path-scope-policy.json` で強制）
- ❌ あなたのデータをモデル学習に使う

## 3. opt-in する外部サービス

設定すると、Kyberion は **そのプロバイダに直接** データを送る（Kyberion 経由ではない）:

| サービス | 送信内容 | タイミング |
|---|---|---|
| Anthropic / Claude | 会話 context + tool 呼び出し | `anthropic` reasoning backend を選んだとき |
| OpenAI / Codex | 同上 | `codex-cli` backend を選んだとき |
| Google Gemini CLI | 同上 | `gemini-cli` backend を選んだとき |
| Local Claude CLI | 同上、ただしローカル CLI 経由 | `claude-cli` を選んだとき |
| Style-Bert-VITS2 (local) | TTS テキスト → ローカルサーバ、外部送信なし | ローカル voice (Phase 2) を opt-in したとき |
| Whisper (local) | STT 音声 → ローカルサーバ、外部送信なし | 同上 |
| Slack / Google Workspace / Notion | 接続が読み書きするよう設定したもの | 接続を作成したとき |

どの backend が active かは常に分かる — `pnpm doctor` や CLI ログが起動時に出力する。

## 4. Egress redaction

外部 LLM への送信時、Kyberion は以下を redact しようとする:

- 一般的な API key パターン (`sk-…`, `AIza…` 等) の文字列
- `secret-actuator` 由来の値
- `knowledge/personal/` および `customer/{slug}/secrets.json` のファイルパス

これは **best-effort で、セキュリティ境界ではない**。Kyberion に処理させるデータはすべて LLM プロバイダに送られる可能性がある前提で扱う。機密データは `KYBERION_REASONING_BACKEND=stub`（オフライン）か、自前ホストの推論エンドポイントで動かす。

より強力な redaction 層は Phase C' の deliverable（`PRODUCTIZATION_ROADMAP.md` G-GV-3）。

## 5. 監査チェーン

state を変える action はすべて `active/audit/audit-{date}.jsonl` にエントリを emit する:

- 通常運用では **append-only**
- 任意で `blockchain-actuator` 経由でパブリックチェーンに anchor 可能（opt-in のみ）
- デフォルトは **ローカルのみ** — 遠隔監査サービスなし

FDE / 顧客案件では、監査チェーンを顧客管理の場所にも書き出すよう設定可能。

## 6. テレメトリ（将来、opt-in）

ロードマップ Phase B-7 で opt-in 匿名テレメトリ層を導入する:

- 匿名クラッシュレポート
- 匿名 "シナリオ N 秒で成功 / 失敗" 統計
- メンテナ管理の集約器に送信
- **デフォルト OFF。実行ごとに opt-in。送信内容を簡単に検査可能**

正確な集約エンドポイントとデータ形状は、機能リリース前に本ドキュメントに記載する。

## 7. プライバシー問題の報告

脆弱性開示は `SECURITY.md` 参照。プライバシー固有の懸念は `privacy` ラベルの GitHub Issue でも提起できる。

## 8. コンプライアンス

Kyberion はソフトウェアツールキットで、サービスではない。コンプライアンス姿勢（GDPR / FISC / SOC2 等）は **デプロイ方法** によって決まる:

- セルフホスト / OSS: データフローは全てあなたが管理
- FDE / 顧客導入: 顧客のコンプライアンス姿勢が適用される。tier スコープと egress redaction を適切に設定
- 将来の Kyberion 管理オファリング: その時点の固有プライバシー通知に従う（本書はそれを暗示しない）

顧客案件での深いコンプライアンス対応は `knowledge/public/fisc-compliance/` および customer aggregation ガイドを参照。
