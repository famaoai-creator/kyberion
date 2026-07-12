# AR-05: 不整合アクチュエータの分割 — 観察と変更、ドメインの境界を引く

> 優先度: P2 / 規模: L(段階) / 依存: AR-01/AR-02 / 関連: IP-10(巨大ファイル分割)、AC-06(能力境界)
> **検証(2026-07-03, Fable)**: wisdom `decision-ops.ts`(~2,831行、~50 case)、system(1,360+765行、86 case)、media(2,627行)を確認。IP-10 が行数、AR-05 が**op-set の一貫性**の角度(別軸)。

## 背景と課題

いくつかのアクチュエータは**観察と変更、無関係なドメインを1つに混載**しており、境界が定義されていない。

- **wisdom-actuator**(`decision-ops.ts` ~2,831行、`dispatchDecisionOp` ~50 case): knowledge CRUD + stakeholder 分析 + PPTX diff + meeting facilitation/action-items + requirements/design/test/task の SDLC ゲート + a2a roleplay + counterfactual + **deploy_release**。「なぜ deploy_release/pptx_diff/transcribe_audio が wisdom に?」— 境界未定義。
- **system-actuator**(`system-pipeline-helpers.ts` 1,360 + `system-action-helpers.ts` 765、86 case): 純診断/capture(pulse*status, list*\*) + OS 変更(mouse_click, keyboard, process_kill, run_applescript) + **file I/O(read_file/write_file/mkdir — file-actuator と重複)** + TTS(voice, native_tts_speak) + 仮想デバイス test harness(test_screen_stream)。catch-all バケツ。
- **media-actuator**(`src/index.ts` 2,627行、~88 case): PDF/PPTX/XLSX/DOCX/diagram/brand/storyline — 事実上複数アクチュエータ。slide-type ラベル(primary/accent/…)が real op(pdf_merge 等)と同じ switch に混在(IP-10 と連結)。
- **media-generation**: 生成 + 画面キャプチャ(capture は AR-04 で system に寄せる)。

## ゴール(受入条件)

1. **op-set の一貫性原則**を定め、混載を解消: 観察(read-only)と変更(mutation)を同一アクチュエータ内で分ける、無関係ドメインは別アクチュエータへ。
2. **wisdom を分割**: knowledge / decision-support / sdlc-gate / meeting に。deploy_release は AC-03(デプロイ能力)へ、pptx_diff は media 側へ移す。
3. **system を分割**: 診断/capture / OS-input-control / device-test-harness に。file I/O は file-actuator(`io:*`, AR-04)へ移す。
4. **media を分割**(IP-10 と統合): document(PDF/PPTX/XLSX/DOCX)/ diagram / brand。slide-type ラベルを real op switch から分離。
5. 分割は op 名の後方互換を保つ(AR-04 のエイリアス経由)。既存テスト緑。

## 実装タスク

### Task 1: 境界設計 — `claude-opus`(設計)

1. 3アクチュエータ(wisdom/system/media)の op を「観察 / 変更 / ドメイン」でクラスタリングし、分割後のアクチュエータ構成と op の移動先を表にする(本文書末尾)。AC-06 の能力境界・AR-04 の語彙・IP-10 の行数分割と統合した1つの分割案にする(別々に割らない)。
2. 移動に伴う op 名の後方互換(AR-04 エイリアス)とルーティング(AR-02 registry)の更新点を定義。

### Task 2: wisdom の分割 — `claude-sonnet-4`

1. `decision-ops.ts` を knowledge / decision-support / sdlc-gate / meeting のモジュール(or アクチュエータ)に分離。deploy_release → AC-03、pptx_diff → media。純 move(ロジック改変なし)を先に、改善は別コミット。
2. 分割前に特性化テスト(IP-07 と協調)を敷き、golden で回帰確認。

### Task 3: system / media の分割 — `claude-sonnet-4`(system)+ `claude-sonnet-4`(media, IP-10 と統合)

1. system: 診断/capture・OS-input・device-test に分離、file I/O を file-actuator へ。
2. media: IP-10 のフェーズ5(media 分割)と**同一作業として**実施(document/diagram/brand)。slide-type ラベルを real op から分離。

## リスクと注意

- **IP-10 と重複しないこと**が重要。IP-10=行数分割、AR-05=op-set 一貫性。media/wisdom は**1つの分割作業に統合**し、二重に割らない(本文書 Task 3 で IP-10 に合流)。
- 分割は高 blast-radius。純 move + 特性化テスト(IP-07)+ golden を各段で。op 名は AR-04 のエイリアスで後方互換。
- deploy_release の移設は AC-03 のオーナーシップに従う。

## 進捗(2026-07-06)

- **完了済み(一部)**: `system-pipeline-helpers.ts` の `write_file` / `write_artifact` / `mkdir` を file-actuator へ forward し、system の混載領域を少し縮めた。`read_json` は既存互換のため system 側に残した。
- **完了済み(一部)**: `AR-03` で file/input contract を導入済みのため、system→file の forward でも前倒し検証が効くようになった。
- **未完了**: wisdom/media の大きな分割、system 残りの OS-input/device-test 境界整理、file I/O の更なる切り出し。
