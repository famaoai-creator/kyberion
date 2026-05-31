---
title: Kyberion ユースケース整合性レポート 50
category: Verification
tags: [verification, use-case, roadmap, coherence, kyberion]
importance: 8
last_updated: 2026-05-30
---

# Kyberion ユースケース整合性レポート 50

このレポートは、現在の `docs/PRODUCTIZATION_ROADMAP.md`、`docs/developer/PRODUCTION_READINESS_PLAN.ja.md`、
`docs/developer/PRODUCT_UX_EVALUATION_2026-05-29.ja.md`、および現行実装を前提に、
代表的なユースケース 50 件を「ロードマップとの整合性」という観点で再点検したものです。

評価の目的は「機能の有無」だけではなく、
「今の Kyberion が、ユーザにとって一貫した体験としてつながっているか」を確認することです。

## 評価基準

- `整合`: ロードマップと現行実装がほぼ一致しており、ユーザ体験としてつながっている
- `部分整合`: 方向性は合っているが、初回体験・復旧導線・運用安定性のどこかに隙間がある
- `要追加`: ロードマップ上の重要項目だが、現行実装にまだ明確な受け口がない

## サマリ

| 判定 | 件数 |
|---|---:|
| 整合 | 28 |
| 部分整合 | 17 |
| 要追加 | 5 |
| 合計 | 50 |

総評としては、Kyberion の戦略軸は一貫している。
とくに `voice first win`、surface 経由の会話、mission / task session、trace / knowledge / governance の線は揃っている。
一方で、初回導線の復旧、surface health の repair UX、channel directory、tool-loop の反復抑止、skill preprocessing は未だ穴がある。

## 50 件のシナリオ

| # | ユースケース | 参照ロードマップ / 実装軸 | 判定 | コメント |
|---:|---|---|---|---|
| 1 | クリーン環境で `baseline-check` を通して初回状態を確認する | Phase A-4 / `setup:report` / `vital:json` | 整合 | 入口の診断は揃っており、first win の前提を確認できる。 |
| 2 | `pnpm onboard` で identity と環境設定を完了する | Phase A-3 / A-4 | 部分整合 | 進行はできるが、依存前提の説明がまだ厚い。 |
| 3 | Voice first win をブラウザ入力 + OS TTS で 1 往復成立させる | Phase A-5 / Appendix A | 部分整合 | 方向性は一致しているが、browser permission に依存しやすい。 |
| 4 | `pnpm vital:json` で readiness を 1 行で把握する | UX-0 / A-4 | 整合 | 情報圧縮の役割が明確で、ロードマップと一致する。 |
| 5 | `surfaces:reconcile` で Slack / WebUI の接続を同期する | Phase A / surface ops | 部分整合 | 実装はあるが、復旧導線はさらに強化余地がある。 |
| 6 | Slack で 1 通送って自然文の返答を受ける | Surface / messaging gateway | 整合 | surface 出力の安全化が効いている。 |
| 7 | Slack から深い分析を `nerve-agent` に委譲する | delegated execution / nerve routing | 整合 | surface から深い reasoning へ落とす線が通っている。 |
| 8 | Slack の「来週の予定教えて」に task session として応答する | `task_session` / schedule coordination | 部分整合 | ルーティングは動くが、質問意図の解釈はまだ揺れる。 |
| 9 | iMessage で短文の会話を継続する | messaging gateway | 整合 | surface の会話継続という基本線は揃っている。 |
| 10 | realtime voice conversation を使って発話と返答を往復する | `realtime-voice-conversation.ts` | 部分整合 | 実装はあるが、環境差の影響を受けやすい。 |
| 11 | README の first-win デモを実際にブラウザで再現する | Phase A-2 / A-6 | 部分整合 | ドキュメントと実体は近いが、安定したデモ素材は不足。 |
| 12 | `surfaces:status` で unhealthy surface を見つけ、復旧判断する | UX-1 / surface health | 部分整合 | 状態表示はあるが、repair への接続がまだ不十分。 |
| 13 | `setup:report --persona first-time-user` で初回ノイズを抑える | UX-2 / Phase A-4 | 部分整合 | 意図は明確だが、first-time-user 向けの圧縮はまだ改善余地あり。 |
| 14 | browser permission を事前検出して first-win 失敗を避ける | UX-0-1 | 部分整合 | 方向性は正しいが、OS 権限まで含めた案内をもっと強くしたい。 |
| 15 | dependency resolver が不足依存を must / should / nice で案内する | Appendix B / A-3 | 要追加 | ロードマップにはあるが、現行体験としてはまだ完全ではない。 |
| 16 | cloud voice へ upgrade して自然な音声対話へ切り替える | Phase A-5.8 / A-7 | 部分整合 | 進化パスは示されているが、切替 UX はまだ詰めどころがある。 |
| 17 | local voice へ upgrade して完全オフライン運用へ寄せる | Phase A-5.8 / Appendix A | 部分整合 | 方向性は揃うが、初期導入コストがまだ高い。 |
| 18 | `KYBERION_STT_COMMAND` で音声入力の橋を差し替える | `speech-to-text-bridge.ts` | 整合 | 入出力をブリッジ化する思想はすでに定着している。 |
| 19 | knowledge query を direct reply として自然文で返す | `surface-runtime-orchestrator.ts` | 整合 | 内部メタを落とした人間向け応答に収束している。 |
| 20 | weather / location query を live query として答える | surface query / service actuator | 整合 | direct reply の設計と齟齬なく動く。 |
| 21 | Slack で mission proposal を生成する | mission proposal flow | 整合 | Slack surface と mission 管理の接続が成立している。 |
| 22 | 承認が必要な操作で approval gate を出す | Sudo Gate / approval path | 整合 | governance の中核として一貫している。 |
| 23 | Slack での確認応答から mission を正式発行する | mission issuance | 整合 | proposal -> confirmation -> issue の線が明確。 |
| 24 | 委譲先の再質問を follow-up として抽出する | delegation summary / follow-up extraction | 整合 | Hermes 分析で拾った改善点が Kyberion にも効いている。 |
| 25 | report generation task を task_session でまとめる | `task_session` / artifact generation | 整合 | durable work の受け皿として妥当。 |
| 26 | browser 系の重い作業を task_session で切り出す | `task_session` / browser workflow | 整合 | mission 化せずに task として持てるのが良い。 |
| 27 | 長時間ミッションを checkpoint / resume で復元する | Phase B-3 / mission durability | 部分整合 | 方向性は正しいが、長時間の実証はまだ弱い。 |
| 28 | ミッション出力と trace を保存して後から追えるようにする | Phase B-1 / Trace | 整合 | 実行結果を読むための土台は揃っている。 |
| 29 | feedback loop で trace から knowledge hint を抽出する | `src/feedback-loop.ts` | 整合 | 自動 distill の土台として一貫している。 |
| 30 | schedule health が repeated failures で自動停止する | `feedback-loop.ts` / schedule registry | 整合 | 反復失敗を放置しない設計は明確。 |
| 31 | secure-io によって危険な path を防ぐ | Rule 1 / secure-io | 整合 | Kyberion の根本的な安全性と整合。 |
| 32 | secret redaction がログとネットワーク出力を守る | `network.ts` / secret guard | 整合 | 外部送信前の redaction がロードマップに合う。 |
| 33 | 3-tier knowledge isolation を守る | Rule 5 / data isolation | 整合 | `personal/confidential/public` の線が一貫している。 |
| 34 | Vault 経由で秘密情報を扱う | Vault / secret handling | 整合 | 直書き依存を避ける方針と一致する。 |
| 35 | PII を自動検知してマスキングする | Phase B / privacy hardening | 部分整合 | 方向性は一致するが、検知精度の改善余地がある。 |
| 36 | ADF の構文エラーを repair して再実行する | validateAndRepairAdf | 整合 | 自己修復のコアとして機能している。 |
| 37 | 同一ツールの反復失敗を止める tool-loop guardrail | Hermes 吸収候補 / B 系補助 | 要追加 | feedback-loop はあるが、tool-call 単位の純粋ガードレールは未整備。 |
| 38 | surface-response-blocks で reasoning leakage を防ぐ | Hermes 吸収済み / surface sanitization | 整合 | 今回の吸収成果が最も効いている領域。 |
| 39 | browser failure 時に screenshot / DOM を残す | `browser-actuator` / diagnostics | 整合 | 失敗の可視化が使える形で存在する。 |
| 40 | `mission_journal` で過去の試行錯誤を検索する | Phase 4 / learning history | 整合 | 開発履歴を再利用できる点は強い。 |
| 41 | README / WHY / Quickstart の入口が一貫している | Phase A-1 / A-2 | 整合 | ポジショニングと入口の整合性は高い。 |
| 42 | bilingual docs を同等に扱う | Roadmap 5.2 / localization policy | 整合 | 英日併記の方針はロードマップと一致している。 |
| 43 | 新規 actuator を contributor が追加できる | Phase C'-5 / plugin authoring | 整合 | 拡張点の方向性は一貫している。 |
| 44 | semver 互換性を検査しながら拡張する | Phase C'-4 / extension stability | 部分整合 | 方向性はあるが、まだ完全な契約境界ではない。 |
| 45 | FDE 向けに customer-specific 設定をまとめる | Phase D'-1 / overlay | 部分整合 | 仕組みは見えているが、操作導線はまだ整理途上。 |
| 46 | クロス OS CI で macOS / Linux / Docker を回す | Phase B-2 / UX stabilization | 部分整合 | 重要度は高いが、定常化はこれからの領域。 |
| 47 | 初回ユーザ向け troubleshooting を 1 枚で案内する | UX-0-3 / docs/user | 要追加 | first-win 失敗時の自己解決導線がまだ弱い。 |
| 48 | surface health に repair command を添えて復旧する | UX-1-2 / surface ops | 部分整合 | 復旧方向はあるが、ユーザに見える形は要改善。 |
| 49 | channel directory で人間向けの接続先を束ねる | Hermes 吸収候補 / channel ops | 要追加 | Slack / voice の運用では有用だが、専用層は未実装。 |
| 50 | skill preprocessing や inline shell で skill を展開する | Hermes 吸収候補 / skill ops | 要追加 | Kyberion の skill 体系とは別系統で、今は未採用。 |

## 結果の読み方

今回の 50 件を通して見えたのは、Kyberion はすでに「思想の筋」は通っているということです。
とくに以下は、ロードマップと現在実装の間で矛盾が少ない領域です。

- surface 出力の安全化
- mission / task session の役割分担
- trace / knowledge / governance の閉ループ
- secure-io と 3-tier isolation を軸にした安全設計
- voice / Slack / browser の surface 分離

一方で、ユーザ目線でまだ引っかかる箇所は明確です。

- 初回セットアップから first win までの失敗復旧
- surface health の stale / repair UX
- troubleshooting の薄さ
- channel directory のような「人間向け接続先の束ね方」
- tool-loop の反復抑止
- skill preprocessing のような記述圧縮の仕組み

## 推奨アクション

1. `docs/user/TROUBLESHOOTING.md` を先に作る
2. `doctor` と first win の間に browser / voice の preflight を入れる
3. `surfaces:status` に repair へ進む runnable command を付ける
4. tool-loop guardrail を `task_session` / `delegate` 系の保護として別設計で追加する
5. channel directory と skill preprocessing は、surface / skill の今の設計に合わせて必要性を再評価する

## 付記

このレポートは理論評価であり、50 件すべてを同一条件で実地運転した結果ではない。
ただし、現行のドキュメント、ロードマップ、実装の相互関係を再点検した結果としては、
Kyberion の方向性は一貫しており、残る課題は「新方針」ではなく「導線の磨き込み」に寄っている。
