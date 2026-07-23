# AC-04 カレンダー調整バックエンド整備

AC-04 のうち、カレンダー経路を先行して実装した記録です。メール経路はこの変更の対象外です。

## 実装した契約

`calendar-actuator` の実装固有の操作は `CalendarBackendAdapter` 抽象と `CalendarBackendRegistry` に閉じ込め、呼び出し側は次の共通操作だけを利用します。Adapter は `id`、可用性判定、4 つのカレンダー操作を実装して登録します。新しい Microsoft 365 / Outlook Adapter はこのレジストリへ追加するだけで、dispatch 本体を変更しません。

- `list_calendars`: カレンダー一覧を `{ name, id, time_zone }` に正規化
- `list_events`: 予定を `{ title, start, end, calendar, location, description }` に正規化
- `query_freebusy`: 空き時間確認を `{ calendar_id, busy, errors }` に正規化
- `create_event`: 作成結果を `{ status, title, id?, error? }` に正規化

標準 Adapter は `jxa` と `gws` です。JXA の `osascript` 呼び出しや Google Workspace の service preset 呼び出しは、この層の外へ漏らしません。`backend` には登録済み Adapter の ID を指定でき、スキーマは特定ベンダーの enum に固定していません。

## 選択規則

`params.backend` で単一 Adapter を明示指定できます。`params.backends` には複数 Adapter の ID を指定でき、読み取り系の結果を統合します。`params.calendar_targets` には Adapter とカレンダー ID/名前の組を複数指定できます。

`auto` の場合は以下で選びます。

1. macOS では Calendar.app 経路 (`jxa`)
2. macOS 以外で gws 認証が利用可能なら Google 経路 (`gws`)
3. どちらも利用できなければ、`gws auth setup` と `gws auth login` を含む前提条件エラー

明示的な `jxa` は macOS 以外では事前に拒否します。gws 認証は既存の `readGwsAuthStatus` を利用し、OAuth 実装を重複させません。複数 Adapter/カレンダーの読み取り結果には `backend` を付与し、どの経路の予定か追跡できます。

## 入力検証

dispatch 前にスキーマを検証します。さらに、次の不足を実行前に例付きで返します。

- `create_event`: `title`、`start_date`、`calendar_names[0]`、`calendar_id`、または `calendar_targets[0]`
- `query_freebusy`: `start_date`、`end_date`

`create_event` は意図しない二重登録を避けるため、backend/カレンダーターゲットを 1 件に限定します。複数カレンダーの横断は `list_events` と `query_freebusy` で利用できます。

これにより、バックエンド呼び出し後に必須値不足で失敗する経路を防ぎます。

## 検証範囲

バックエンド選択、gws 結果の正規化、入力不足、freebusy の契約をモックテストで固定しています。実際の Calendar.app への書き込みと gws OAuth セッションは、認証情報とテスト用カレンダーが必要なため CI の対象外です。
