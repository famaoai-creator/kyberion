`task-session.schema.json` は、surface 会話から起動される長めの作業を統一的に扱うための contract です。

狙い:
- 会話を止めずに作業セッションを起動する
- `browser`, `capture_photo`, `workbook_wbs`, `presentation_deck`, `report_document`, `service_operation` などを同じ枠組みで扱う
- 進捗、要求不足、生成物を surface / chronos から同じ方法で追えるようにする

サンプル:
- `task-session-capture-photo.example.json`
- `task-session-workbook-wbs.example.json`
- `task-session-presentation-deck.example.json`
- `task-session-report-document.example.json`
- `task-session-service-operation.example.json`

設計上の考え方:
- `surface-agent` は会話と requirement 収集に集中する
- 実行は operator / actuator に渡す
- 完了結果は `artifact` と `history` に集約する
