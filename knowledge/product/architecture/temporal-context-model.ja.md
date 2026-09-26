---
title: 時間コンテキストとカレンダーワークフローモデル
tags: [temporal, calendar, scheduling, business-days, timezone]
last_updated: 2026-09-26
---

# 時間コンテキストとカレンダーワークフロー

Kyberion では、時間を特定のカレンダーベンダーの属性として扱わず、共通の解釈層として扱う。`TemporalContext` は現在時刻、IANA タイムゾーン、勤務時間、営業日カレンダー、標準所要時間を持ち、カレンダー、スケジューラー、組織 operation が共有する。

流れは次のとおり。

```text
カレンダー状態を取得 → 時間表現を正規化 → 空き枠・締切を計算
→ 変更案を作成 → 承認 → 外部状態を変更 → 状態を再確認
```

`business-calendar.ts` は時間コアの一部であり、日本の銀行営業日と締切日を計算する。外部 provider との通信は担当しない。カレンダー provider は `calendar-provider` seam の adapter とし、freebusy を取得した後の空き枠計算は provider に依存しない。

`calendar-actuator:find_slots` は読み取りと計算を行う操作であり、タイムゾーン、勤務時間、所要時間、営業日制約を freebusy 結果に適用する。外部予定の作成や変更は行わない。

適用段階の操作も adapter capability として表現する。`update_event` は再スケジュール、予定内容、リマインダー設定を扱い、`delete_event` は削除を扱う。actuator は Google や Microsoft 固有の URL・payload を判定せず、選択された adapter の capability を呼び出す。未対応 adapter は capability 不在として明示的に失敗する。
