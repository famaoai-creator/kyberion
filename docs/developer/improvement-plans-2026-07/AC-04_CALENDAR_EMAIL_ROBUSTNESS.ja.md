# AC-04: カレンダー/メール能力の堅牢化とプラットフォーム依存の緩和

> 優先度: P1 / 規模: M / 依存: AC-01(前提条件宣言) / 関連: IP-05(入力スキーマ検証)

## 背景と課題

カレンダー・メールは生活/業務ユースケース(USE_CASES #21-30 の予約・調整系ほか)の中核なのに、実行時エラーが最多クラスで、macOS ロックが強い。

- **契約エラーが最多**: `calendar-actuator: create_event requires title, start_date, and calendar_names[0]` が **47 回**記録(unclassified-error-registry)。呼び出し側(意図解決)が必須パラメータを埋めずに実行し、実行時に初めて落ちる構図。
- **経路が2系統あり整理されていない**:
  - calendar-actuator は macOS Calendar.app を JXA/osascript で操作(`libs/actuators/calendar-actuator/src/calendar-actuator-helpers.ts:141`)。
  - 一方 `google-workspace` preset(`gws` CLI 経由)には `calendar_events_list/insert`、`calendar_freebusy_query` 等の実 op があり、`libs/core/email-workflow.ts` は Gmail の読取/トリアージ/アーカイブ/送信まで実装済み。**Google 経路のほうが深いのに、actuator の正面口は macOS 経路**。
- **email-actuator は送信専用の薄い層**(138行): Mail.app(darwin)/SMTP(送信のみ、draft 不可)。受信・検索は email-workflow(gws)側にしかない。
- **macOS 外では calendar/email(draft) が丸ごと使えない**(`email-actuator/src/index.ts:6,26`、calendar は JXA 必須)。V-1-10(マルチプラットフォーム)PARTIAL の主因。
- `gws` は外部 CLI・セッション認証(`gws auth login`)依存で、未ログイン時の失敗が分かりにくい。

## ゴール(受入条件)

1. `create_event` 等の必須パラメータ不足が、実行前の検証エラー(不足項目と例を明示)または明確化質問に変わり、47 回級の実行時エラーが止まる。
2. calendar/email の各 op に「macOS 経路 / Google(gws)経路」のバックエンド選択が入り、環境に応じて自動選択される(darwin + Calendar.app → JXA、gws ログイン済み → Google、両方不可 → AC-01 形式の前提条件エラー)。
3. gws 未ログインが事前検知され、「`gws auth login` を実行してください」という充足手順付きエラーになる。
4. `docs/USE_CASES.md` が想定する Google カレンダー系シナリオ(#21-30)が非 macOS でも成立する(gws 経路)。

## 実装タスク

### Task 1: 入力契約の事前検証 — `claude-sonnet-4`

1. calendar-actuator の 3 op(listCalendars/listEvents/createEvent)に入力スキーマ(`schemas/` に追加)を定義し、IP-05 の共通ランナー `schema` オプション(未導入なら dispatch 冒頭のローカル検証)で実行前検証する。エラーは「不足: start_date(例: 2026-07-15T10:00:00+09:00)」形式。
2. 意図解決側: カレンダー系意図の `question-resolver` 必須入力(title/start_date/calendar)を確認し、欠落時は実行せず明確化質問を出す経路になっているかをテストで固定する(出ていないから 47 回落ちている可能性が高い — 原因を特定して修正)。
3. email 送信系(to/subject/body)にも同様のスキーマを定義する。

### Task 2: バックエンド選択層 — `claude-sonnet-4`

1. calendar-actuator のヘルパーに backend 抽象(`jxa` | `gws`)を導入し、op ごとに google-workspace preset の対応 op(`calendar_events_insert` 等)へマップする。選択順: 明示指定 > 環境自動判定(darwin かつ Calendar.app 利用可 → jxa / gws セッション有効 → gws)。
2. `gws` セッション有効性のプローブ(軽量コマンドの exit code、TTL キャッシュ)を AC-01 のプローブ機構に登録する。
3. email-actuator にも同様に、draft/送信の backend として email-workflow(gws)経路を追加する(darwin 以外での draft を gws の `gmail` draft op で実現)。email-workflow 側の既存実装(`libs/core/email-workflow.ts:304-388,860-890`)を呼ぶだけにし、ロジックを複製しない。
4. 両経路の結果形式を統一し、既存テスト + backend 別の新テスト(gws はモック)で検証する。

### Task 3: manifest / カタログ更新 — `claude-haiku`

- Task 1-2 の結果を manifest(prerequisites: darwin or gws)・`CAPABILITIES_GUIDE.md`(AC-01 Task 4 の生成)・`knowledge/product/orchestration/supported-actuators.md` の記述(「macOS のみ」→ 実態)に反映する。

### Task 4: E2E 確認 — `claude-sonnet-4`

- 代表シナリオ「明日 10 時に『歯医者』の予定を入れて」を、(a) パラメータ完備、(b) start_date 欠落(→ 明確化質問)、(c) gws 未ログイン(→ 充足手順エラー)の 3 通りで CLI から実行し、期待挙動を確認・記録する(実カレンダーへの書き込みはテスト用カレンダー名を使用)。

## リスクと注意

- Google 経路は外部 CLI(`gws`)のバージョン挙動に依存する。preset の op 名と CLI 引数の対応が壊れた場合に備え、gws 呼び出しはモック可能な 1 関数に集約する。
- OAuth を自前実装しない(ロードマップ非目標に隣接)。認証はあくまで `gws auth login` のセッションに委ね、Kyberion 側はプローブと案内のみ。
- Calendar.app(JXA)経路の挙動は変えない(既存ユーザーの回帰防止)。
