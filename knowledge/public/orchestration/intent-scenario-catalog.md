---
title: Kyberion Intent Scenario Catalog
category: Orchestration
tags: [orchestration, intent, onboarding, voice, slack, schedule, video, mission]
importance: 9
author: Ecosystem Architect
last_updated: 2026-05-31
---

# Kyberion Intent Scenario Catalog

この文書は、利用ユーザが Kyberion を使い始めてから日常運用に乗せるまでの代表的な intent シナリオを、`intent -> execution profile -> capability bundle -> service/actuator -> result` の流れで整理したものです。

目的は「ユーザが何を言えばどの actuator 群に落ちるか」を明確にし、足りない設定があれば安全に設定フローへ戻すことです。

## 1. Shared Flow / 共通の流れ

すべてのシナリオはまず shared coordination brief に正規化されます。

```text
user request
-> shared coordination brief
-> intent normalization
-> execution profile
-> capability bundle
-> service endpoint / actuator binding
-> execution or fallback
-> artifact / status / next action
```

### What the user sees

- 何が理解できたか
- 何が足りないか
- 何を設定すれば次に進めるか
- 実行した場合の成果物は何か

### What Kyberion does

- intent を自然言語から正規化する
- profile と capability bundle を選ぶ
- service endpoint / actuator を決める
- 必要なら setup intent にフォールバックする
- 実行後に result artifact と next action を返す

## 2. Scenario Matrix / シナリオ一覧

| Scenario | Example utterance | Normalized intent | Execution profile / capability bundle | Primary service / actuator | Fallback when prerequisites are missing |
|---|---|---|---|---|---|
| First-run onboarding | `オンボーディングして` | `launch-first-run-onboarding` | `platform_onboarding` / onboarding bundle | onboarding protocol, `launch-first-run-onboarding` | `verify-environment-readiness` → `bootstrap-kyberion-runtime` |
| Runtime readiness check | `設定が正しいか確認して` | `verify-environment-readiness` | readiness bundle | environment manifests, runtime checks | `bootstrap-kyberion-runtime` or `configure-reasoning-backend` |
| Reasoning backend setup | `推論 backend を設定して` | `configure-reasoning-backend` | backend selection bundle | reasoning backend registry | ask for backend preference if missing |
| Organization toolchain setup | `Slack や CI/CD も含めて連携して` | `configure-organization-toolchain` | org-toolchain bundle | service binding / toolchain registries | `setup-messaging-bridge` / deployment adapter setup |
| Presentation preference setup | `資料の見た目も覚えておいて` | `register-presentation-preference-profile` | presentation profile bundle | presentation preference registry | ask for audience/theme hints |
| Voice profile registration | `自分の声を使えるようにして` | `clone-my-voice` / `speak-with-my-voice` | voice profile bundle | `voice-actuator`, voice profile registry | `collect-voice-samples` → `register-voice-profile` → `promote-voice-profile` |
| Voice generation | `声で読んで` | `speak-with-my-voice` | `voice-speak-with-my-voice-local-say` | `voice-actuator` | if voice profile missing, route to voice setup |
| Live voice conversation | `ライブ音声で会話したい` | `live-voice` | `voice-live-conversation-default` / `realtime-voice-governed` | `voice-actuator` + `whisper` + `meeting` bindings | if mic/STT missing, fall back to voice setup or STT bridge setup |
| Batch transcription | `この音声を書き起こして` | `transcribe-audio` | `audio-transcribe-default` / `audio-transcription-governed` | `whisper` service endpoint | if audio source is missing, ask for file path or asset |
| Slack bridge activation | `Slackサービスと連携して` | `setup-messaging-bridge` | messaging bridge setup bundle | `service-actuator` + declared bridge | if credentials or manifest missing, ask for channel/platform details |
| Mission inventory | `ミッション一覧を教えて` | `inspect-mission-inventory` | mission inventory bundle | `mission_controller list` | if inventory scope is unclear, ask whether the user wants all missions or a filtered subset |
| Mission detail | `このミッションの履歴を見せて` | `inspect-mission-state` | mission state bundle | `mission_controller status <ID>` | if mission ID missing, ask for target mission |
| Scheduled task inventory | `スケジュールタスクの一覧を教えて` | `inspect-generation-schedules` | generation schedule bundle | `schedule:list` / `run_generation_schedule --action list` | if the user means calendar events instead, route to `schedule-read-agenda` |
| Calendar agenda readout | `来週の予定を教えて` | `schedule-read-agenda` | schedule read bundle | calendar / agenda inspection | if calendar scope missing, ask for date range or account |
| Schedule coordination | `来週の予定を調整して` | `schedule-coordination` | schedule coordination bundle | calendar actuator / browser calendar procedure | if meeting-specific, hand off to `meeting-operations` |
| Video creation, prompt-based | `動画を作成して` | `generate-video` | `media-generate-video-default` / `video-generation-governed` | `media-generation-actuator` | if rendering prerequisites are missing, route to readiness or media setup |
| Narrated video creation | `説明付き動画を作って` | `generate-narrated-video` | narrated video bundle | `voice-actuator` + `video-composition-actuator` + render backend | if narration prerequisites are missing, route to voice setup |
| Music video creation | `ミュージックビデオを作りたい` | `generate-video` + `music_video` content mode | music-video bundle | `media-generation-actuator` + `video-composition-actuator` | if music asset is missing, fall back to music generation setup |
| Code documentation video | `ソースコードを説明する動画にして` | `generate-narrated-video` + `code-analysis` overlay | code-doc video bundle | code analysis + voice + video composition | if source path missing, ask for repo/path and doc format |
| Meeting operations | `会議に入って要点を整理して` | `meeting-operations` | meeting bundle | `meeting-actuator`, `meeting-browser-driver` | if meeting provider is missing, ask for provider / mode / node |

## 3. Onboarding Ladder / オンボーディングの段階

ユーザが Kyberion を初めて使う場合、以下の順番に進むと迷いにくくなります。

1. `launch-first-run-onboarding`
2. `verify-environment-readiness`
3. `bootstrap-kyberion-runtime`
4. `configure-reasoning-backend`
5. `configure-organization-toolchain`
6. `register-presentation-preference-profile`
7. `setup-messaging-bridge` for Slack
8. `speak-with-my-voice` / `clone-my-voice`
9. `inspect-mission-inventory`
10. `inspect-generation-schedules`
11. `generate-video`

この順番は固定ではありませんが、最初の利用体験としては「環境 -> 音声 -> Slack -> 運用確認 -> コンテンツ作成」が最も自然です。

## 4. Fallback Rules / フォールバック規則

### 4.1 When setup is missing

次のように、実行 intent から setup intent へ安全に落とします。

- `generate-video` で renderer や media preset が不足
  - → `verify-environment-readiness`
  - → `configure-organization-toolchain`
  - → 必要なら `register-actuator-adapter`
- `speak-with-my-voice` で voice profile が未登録
  - → `collect-voice-samples`
  - → `register-voice-profile`
  - → `promote-voice-profile`
- `live-voice` で STT / mic routing が不足
  - → `verify-environment-readiness`
  - → `configure-organization-toolchain`
  - → `setup-messaging-bridge` ではなく voice setup へ戻す
- `setup-messaging-bridge` で Slack credential / manifest が不足
  - → 必要情報の確認
  - → credentials 登録
  - → `service-actuator` 連携確認

### 4.2 When the user request is underspecified

Kyberion は不足情報を補うために clarification を返します。

典型的に聞き返す内容:

- どの workspace / account か
- どの timeframe か
- どの voice / Slack / meeting provider か
- どの output format か
- 実行してよいか、確認だけか

### 4.3 When the request changes domain

ひとつの intent が別の domain に変わる場合は、途中で `handoff` します。

例:

- schedule edit が meeting-specific になる
  - `schedule-coordination` -> `meeting-operations`
- voice recording が profile creation に変わる
  - `live-voice` -> `clone-my-voice`
- video request が narrated build に変わる
  - `generate-video` -> `generate-narrated-video`

## 5. Service and Actuator Linking / サービスとアクチュエータの紐付け

この catalog は intent を直接 actuator 名に落とすのではなく、サービス・エンドポイントと capability bundle を経由させます。

| Layer | Role |
|---|---|
| Intent | ユーザの意図そのもの |
| Execution profile | その intent に対する既定の実行方針 |
| Capability bundle | 使う機能のまとまり |
| Service endpoint | `service-presets/*.json` や declared bridge の選択 |
| Actuator | 実行本体 |
| Artifact / status | 結果と次の行動 |

この分離により、ユーザは「何をしたいか」だけを言えばよく、`Slack`, `voice`, `video`, `meeting`, `mission` のようなドメイン差は内部で吸収されます。

## 6. Operator-Facing Summary / オペレーター向け要約

最初に覚えるべき intent は次の 4 群です。

1. `launch-first-run-onboarding`
2. `speak-with-my-voice` / `live-voice`
3. `setup-messaging-bridge`
4. `generate-video` / `generate-narrated-video`

そのうえで、運用確認として:

- `mission_controller list`
- `schedule-read-agenda`
- `inspect-runtime-supervisor`

を使うと、Kyberion の状態を把握しながら次の作業に進めます。

## 7. Related Docs / 関連文書

- [`knowledge/public/architecture/kyberion-intent-catalog.md`](knowledge/public/architecture/kyberion-intent-catalog.md)
- [`knowledge/public/orchestration/actuator-intent-normalization.md`](knowledge/public/orchestration/actuator-intent-normalization.md)
- [`knowledge/public/orchestration/guided-coordination-protocol.md`](knowledge/public/orchestration/guided-coordination-protocol.md)
- [`knowledge/public/orchestration/onboarding-protocol.md`](knowledge/public/orchestration/onboarding-protocol.md)
- [`knowledge/public/orchestration/mission-playbooks/messaging-bridge-orchestration.md`](knowledge/public/orchestration/mission-playbooks/messaging-bridge-orchestration.md)
- [`knowledge/public/orchestration/schedule-coordination-playbook.md`](knowledge/public/orchestration/schedule-coordination-playbook.md)
- [`knowledge/public/orchestration/voice-interface-protocol.md`](knowledge/public/orchestration/voice-interface-protocol.md)
- [`knowledge/public/orchestration/supported-actuators.md`](knowledge/public/orchestration/supported-actuators.md)
