---
title: Hermes additional adoption implementation and operating boundaries
tags: [hermes-agent, implementation, security, recovery, continuous-execution, ux]
last_updated: 2026-10-28
status: implemented
runtime_stages: [execution, review]
---

# Hermes 追加採用の実装と運用境界

[比較調査](hermes-additional-adoption-deep-dive-2026-10.md) の推奨順を実装へ接続した記録。
以前の UI/UX・費用・連続実行の差分を保持し、既存の scope、WorkItem、approval、artifact、journal、alert を拡張する。
総実行時間の固定上限は再導入しない。以下の期限は、操作の観測・承認・保存・復旧に対する期限である。

## 実装した範囲

| ID  | 実装と実際の接続先                                                                                                                          | 境界                                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A01 | `session-git-index` の自動 object / index probe を共通 hardened Git helper へ接続                                                           | 実際に使う引数文法に限定。汎用 status / worktree diff は拒否し、設定発見後の未知 filter 追加でも実行 sink を開かない。通常の承認済み Git 操作は既存経路 |
| A02 | `untrusted-content` の検出専用 normalized view と Unicode indicator                                                                         | 原文を保持し、日本語・emoji・引用文の検知回帰を追加。検知は authority の代替ではない                                                                    |
| A03 | tenant knowledge の `hits / empty / unavailable / rejected` と partial flag、mission context pack の状態通知                                | 外部 tenant の存在を返却状態から区別しない。正常な空検索と読み取り失敗を分離                                                                            |
| A04 | TUI tail reader の truncation・省略・破損行・missing / unavailable と stats 表示                                                            | 取得失敗を正常な空一覧と表示しない。秘密を含み得る例外文は表示しない                                                                                    |
| A05 | 既存 OAuth session に principal-bound operation receipt、観測 API、設定画面の操作カード                                                     | callback が完了 authority。カードを閉じても consent を取消さない。状態取得は認証済み principal に限定                                                   |
| A06 | plugin 単位 lock、旧 fingerprint の CAS、code＋install record の publication、journal recovery                                              | 中途失敗は旧 code / record を復元。新しい digest に旧 grant を流用しない                                                                                |
| A07 | 既存 ops-alert ledger 上の job＋原因 incident projection、feedback-loop caller、TUI ack                                                     | ack は確認のみ。復旧後の再発・別原因は新たに表示し、ジョブ再実行や権限を許可しない                                                                      |
| A08 | task-local credential binding、service binding / secret lookup、CLI env、API client と probe の所有境界                                     | テナント実行の scoped miss は personal env / cache / vault / keychain へ戻らない。未設定は拒否                                                          |
| A09 | TUI の承認対象・期限・digest と既存 GUI review 先への導線                                                                                   | 承認判断と exact scope は既存 facade。TUI に Session / Always 権限を新設しない                                                                          |
| A11 | 正常圧縮前の opt-in immutable scoped snapshot と receipt                                                                                    | 保存・検証・journal commit に失敗した場合、元の履歴を保持して needs-attention を返す                                                                    |
| A12 | 同じ worker journal の compaction lineage と唯一の current tip の復元                                                                       | scope・親・世代・内容 hash・期限を照合。古い context は履歴として扱い、tool / 通知の effect を再実行しない                                              |
| A13 | 永続 agent 指示ファイルの変更意図を logical / canonical path と内容 digest で識別し、既存 policy / audit へ接続                             | 観測時点の write intent。完了した差分の独立証明や追加 approval ではない。opaque shell / patch は対象未解決のまま明示                                    |
| X01 | 実行時 source snapshot を既存 quality report に保持し、operator home / Chronos に鮮度を投影                                                 | `current / partial / stale / unknown`。後から現在の bytes を採取して古いテストを新鮮と認定しない                                                        |
| X02 | fake-provider の実 goal loop・CLI usage round-trip・cancel 後の遅延結果・品質 gate と、既存 health / compaction 回帰をまとめた replay probe | 実 provider の性能・費用比較ではない。既存 probe runner / decision axis を再利用                                                                        |

## 認証情報の組み込み

`withTaskCredentialBinding` は信頼できる dispatch code が使う API であり、model / HTTP payload から値を渡す入口ではない。
既存 `SecretResolver` の任意の `bindTask` adapter を coordinated dispatch に接続し、claim 後の実行に設定を束縛する。
tenant と現在の mission / task は runtime から固定し、binding の省略でタスク間共有へ戻らない。
resource access scope は deny-only ceiling として扱い、異なる tenant を名乗る材料にはしない。
fallback のidentityは既存のproject scope resolverを通し、保存済みscopeと環境設定を共通の規則で解決する。
明示されたexecution identityを優先し、不正なtenant設定はoperator扱いへ落とさず拒否する。保存済みtenant scopeでもcredential adapterが必要になる。
service grant・plugin grant・temporal grant・egress policy は引き続き必要で、credential binding 自体はそれらを付与しない。

テナント用の adapter が未設定なら、credential を必要とする処理は `CREDENTIAL_BINDING_REQUIRED` 等で停止する。
既存の operator backend を tenant 実行へ使い回して解決しない。tenant adapter はその実行で必要な key と、CLI であれば専用 HOME の環境だけを供給する。
CLI の HOME / auth state は governed tenant storage 内の実体を検証し、別名 symlink・hardlink・特殊ファイル・上限を超える走査は拒否する。
子プロセスには canonical tenant / mission / task を再付与し、credential adapter からの SUDO・persona 等の authority 注入は通さない。これは spawn 前の設定検証であり、OS の process sandbox の代替ではない。
値はイベントや WorkItem に保存しない。単独 operator の設定は既存の解決経路を使用できるが、その cached client / service binding を別 tenant へ持ち込むことは拒否する。

Anthropic の reasoning / intent / voice は tenant 用 SDK client を bound key から生成し、opaque injected client と ambient auth token / custom headers / base URL の取り込みを拒否する。tenant client の接続先は公式 endpoint に限定する。
Gemini / Grok / OpenAI-compatible / OpenRouter の key 選択と availability probe も同じ binding 境界を使用する。
永続 native transport（UAA / ACP、Codex app-server、Claude persistent session、Claude Agent SDK wrapper）は tenant の auth isolation をまだ保証しないため、tenant 実行を明示的に拒否する。
単発の shell Claude CLI、stateless Codex CLI / isolated Codex query は scoped env 境界を使える。operator の既存 native 利用は保持する。
`CREDENTIAL_*` の scope・owner・設定拒否は policy hard stop とし、global provider health を demote しない。`CREDENTIAL_NATIVE_UNSUPPORTED` 単独は capability 不足として、許可された候補への failover が可能である。

## 圧縮と復元の設定

mission task の任意フィールドで有効にする。

```json
{
  "compaction_durability": {
    "retention_ms": 604800000,
    "restore": true
  }
}
```

元の tier / tenant / mission / task を維持した internal artifact に raw history と圧縮結果を保存し、既存 journal に receipt だけを記録する。
API の保持期限既定値は7日、上限30日。task contract では有限の `retention_ms` を明示する。
snapshot は最大16 MiBで、scope・index・内容 hash・親・世代・作成時刻・期限を照合する。
期限後の restore は拒否し、次回圧縮または明示的な journal maintenance で期限切れ artifact を削除する。
message 単位の source tier が不明なため、read scope の最高感度より低い write tier へ raw history を保存しない。通常時は圧縮をスキップして元の sections を保持し、force / durability 指定時は `COMPACTION_SCOPE_NEEDS_ATTENTION` とする。許可済みの model input scope を書き換えるものではない。
休止した scope の期限ちょうどの物理消去を保証する時刻駆動 GC は今回追加していない。
現在の pinned goal / scope を優先し、復元した内容から承認や tool 実行を自動再生しない。

## 操作と復旧の期限

OAuth の pending session は既存の開始期限を守り、完了後は verifier / CSRF state を削除して秘密を含まない短命 receipt に置き換える。
receipt は5分で失効する。観測不能は未完了・接続失敗・期限切れを証明しない。
ジョブ incident の ack は24時間。成功復旧後に同じ原因が再発した場合も再び detected とし、異なる scope の job を同一視しない。
ack は画面で確認した episode に束縛し、同じ原因の新しい再発へ古い確認操作を適用しない。原因変更による置換は superseded、成功による復旧は recovered と表示を分ける。
承認一覧でも、明示された tier / tenant / organization / project の矛盾を、閲覧可能な mission のラベルで救済しない。
plugin publication に失敗する前に新 digest の pending approval が作成されていた場合、その未適用 request は残り得る。
同じ内容の retry だけが再利用でき、旧 install record / 旧 grant には結合しない。未知の bytes を検出した recovery は自動上書きせず停止する。

## 検証範囲と replay

quality source receipt は実行前後の内容が一致した場合だけ作成する。
`executeQualityRun` の対象は宣言された exact source set であり、通常は targeted と記録する。
source の変更は stale、receipt 不在・別 worktree・読めない source は unknown とする。
表示は freshness であり、テスト成功・全 repository coverage・公開承認の認定ではない。

replay の定義は `eval/runtime-replay/probe.json`。既存 `loadProbeScenario` → `runProbe` で scratch copy から実行し、結果 JSON を保存する。
これは現在の checkout に対する回帰 battery であり、overlay candidate のコードを自動採用する benchmark ではない。
実 goal loop が従来の100 turnを超えて step admission 付きで完了すること、無効 tool output を実行しないこと、cancel 後の遅延成功を採用しないことを fake transport で確認する。
provider usage と文字数推定が異なる fixture も使い、請求情報のない費用を無料と扱わない。
実 provider の token / latency / 品質の比較、実サービス OAuth、長期間の daemon 再起動運用は別途の実測が必要。

## 条件付きの項目

- **A10 入力キュー:** 操作量の測定と server-owned admission / delivery uncertainty の必要性を確認してから。現行の busy draft 保持を維持する。
- **A14 学習 graph:** 知識量の実測後に、既存 provenance / curation 上の advisory として検討する。語彙一致を authority にしない。
- **MoA・served model・環境 backend の大きな再編:** 比較調査に記した任意採用・費用・egress・需要の条件を維持する。

実装・レビュー・実行した検証の証跡は `MSN-HERMES-ADOPT-20261028` に記録する。

レビュー登録・抽出方法の表示・プロセス復旧replayの追加改善は、[レビュー証跡と復旧検証](review-provenance-and-recovery-2026-10.md)を参照する。
