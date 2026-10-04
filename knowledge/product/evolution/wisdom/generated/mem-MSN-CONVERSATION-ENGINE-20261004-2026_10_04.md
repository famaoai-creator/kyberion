---
record_id: mem-MSN-CONVERSATION-ENGINE-20261004-2026_10_04
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-CONVERSATION-ENGINE-20261004-2026_10_04
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-04T13:48:21.487Z
source_branch: feat/conversation-engine-20261004
source_commit: fc216c576b77d984fb071310084909fbdc6b2ddc
---

# Conversation Engine: 音声ループへの反応経路と汎用対話制御の設計パターン

LLM外側のConversation Engineを音声対話に導入する際の設計・移行パターン。判定機械を言語パック駆動の汎用エンジンに抽出し、レガシー互換を保ったまま新アクションだけをループに適用するシャドー移行が有効だった。新しい音声出力経路はエコーコンテキスト登録・再生後ドレイン・pause/resume・シャットダウン排出の4点を全て配線しないと自己発話を誤認する。

## Hint Scope

mission

## Trigger Phrases

- 音声会話を STT→LLM→TTS 直列から進化させるとき、ターンテイキング機械は `libs/core/interaction/` の汎用エンジンとして抽出し、モダリティ固有部分(VAD/STT/TTS名、RMS、エコー)はアダプタ注入にすると会話以外にも再利用できる。実践したパターン: (1) エンジンはpure・イベント駆動・注入時計で workbench と同一機械を本番と共有。(2) 既存 action の形を壊さないため新メタデータ(intent等)はopt-inにし、従来アクションを発する判定パスは残したまま新アクション(emit_backchannel)だけをループが消費するシャドー移行。(3) 語彙は全て governed lexicon の言語パックにし、uses_word_spaces も含めてデータで渡す(日本語ファースト・多言語拡張)。(4) 新しい音声出力経路(相槌等)は lastAssistant への登録・再生後の mic ドレイン・pause/resume 意味論・終了時 stop の4点を配線しないと、スピーカー環境で自己発話をユーザー発話として拾い推論を発火する。(5) リズム計測のギャップはエージェント出力を挟む区間を除外しないと全ユーザーで上限に飽和する。

## Recommended References

- active/missions/public/MSN-CONVERSATION-ENGINE-20261004/evidence/distillation.md
- active/missions/public/MSN-CONVERSATION-ENGINE-20261004/evidence/implementation-report.md
- active/missions/public/MSN-CONVERSATION-ENGINE-20261004/evidence/retrospective.md

## Evidence

- active/missions/public/MSN-CONVERSATION-ENGINE-20261004/evidence/distillation.md
- active/missions/public/MSN-CONVERSATION-ENGINE-20261004/evidence/implementation-report.md
- active/missions/public/MSN-CONVERSATION-ENGINE-20261004/evidence/retrospective.md

## Artifacts
