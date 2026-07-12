# 改善計画 再レビュー(Fable 5, 2026-07-03)

> **背景**: 改善計画群(IP/UX/AC/KM/MO/DS/AA/SA/OP/IL/ONB/SU/HO/HN/AO/CO)は Opus が調査ベースで起草した。本レビューは Fable 5 が **実コードに照らして批判的に再検証**したもの(要約でなく判定)。5カテゴリを並列で file:line 突き合わせ、Fable が統合判断した。
> **方法**: 各計画の load-bearing な主張を実ファイルで確認/反証。参照文書5本は Fable が直接精査。
> **注記**: 本レビューは「過大評価しすぎない」ことも誠実さの一部として、over-confidence を実態どおり**偏在**として報告する(一律の断罪はしない)。

---

## 0. 総括(一段落)

**計画の前提は約75%が行単位まで正確で健全**。特に **SA(セキュリティ)・KM(ナレッジ)・AA(通信)系は極めて精確**(kill-switch の caller ゼロ、egress の fail-open、汚染ファイル1387件、cron ゼロ配線など、実コードと寸分違わず)。一方で **over-confidence は実在するが偏在**しており、(a)「機能が無い/未配線」と断じたが**部分実装が既にある**類、(b) 数値の水増し/取りこぼし、(c) 具体的な誤記、(d) 未認識の計画間衝突、(e) CO 系の投機的な過大スコープ、に集中する。皮肉なことに、この over-confidence 自体が `FABLE5_AGENT_MODEL` の第一原則「成功を誇張せず、不確実を確実と偽らない」に反しており、**その参照文書自身も著者を Opus でなく Fable と誤記**している。

判定内訳(83計画): **SOUND ~62 / NEEDS-REVISION ~18 / FLAWED 2**。

---

## 1. 最重要: 「無い」と断じたが実在する(実装者を誤誘導する)

これが品質上の最大の問題。計画どおり着手すると、既にある物を再構築してしまう。

| 計画      | 計画の主張                                                  | 実際(file:line)                                                                                                                                                                         |
| --------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MO-04** | context pack は dispatch で未使用                           | `scripts/refactor/mission-workitem-dispatch.ts:658,700` の本番 CLI 経路では**配線済み**。真なのは orchestration-worker 経路のみ                                                         |
| **MO-07** | 品質 severity を consume する redo/escalation が皆無        | `uncertainty_gate` が convergence_severity を消費(`decision-ops.ts:2750`)。二世界テーゼ自体は成立                                                                                       |
| **AC-03** | デプロイ adapter の登録手順が実質未整備                     | `ShellDeploymentAdapter` クラス実装済(`deployment-adapter.ts:88`)+ env 駆動の自動登録 `installShellDeploymentAdapterIfAvailable`(`:126`)が既にある。実スコープは config 経路+承認の追加 |
| **KM-03** | queue 消費は手動 `memory-promote <id>` のみ                 | 一括消費 `memory-promote-pending [--dry-run]`(`mission_controller.ts:1123`)も既存(手動だが bulk 可)                                                                                     |
| **OP-03** | Dockerfile を「実行時フルビルドしない真の multistage に」   | **既に真の multistage**。production stage は builder から dist を COPY し build を走らせない(`Dockerfile:42-57`)。残る正当な論点は `COPY . .` と compose の dev-only 定義のみ           |
| **OP-04** | health/metrics エンドポイントが無い                         | `operator-surface/src/app/health/page.tsx` が health surface として稼働。正しくは「Chronos Mirror に限れば無い」                                                                        |
| **AO-01** | run-lock が無く tick が前回完了を待たず発火                 | `chronos_daemon.ts:~95-100` が `lastRun` を実行前に楽観スタンプする**意図的な overlap ガード**が存在                                                                                    |
| **AO-03** | watch_tenant_drift が notify-slack.sh に Slack 通知を投げる | `watch_tenant_drift.ts:18` は docstring の「Cron 例」コメント。read-only で実際には呼ばない(sink 不在という根の問題は真)                                                                |

→ **対応**: これら8計画の「背景」を「部分実装あり、残りは差分」に修正。実スコープは縮小する。

---

## 2. 数値の水増し/取りこぼし(方向は不統一)

セキュリティ/ナレッジの数値は精確だったが、コード品質/デザインの数値はドリフトしている。

- **IP-11**: `as any` 1,175 → 実 **528**(非テスト。テスト・別 cast 形を含めた水増し。約2.2倍)
- **DS-01**: operator-surface のインラインスタイル「約250」→ 実 **111**(約2.3倍)。hex 約125 は正確(実130)
- **DS-05**: presence-studio ARIA「12(最良)」→ 実 **~7**
- **IP-04**: `*-pipeline` スキーマ「8」→ 実 **11**
- **IP-05**: 無検証 `handleAction(JSON.parse)`「17」→ 実 **20**(前提はむしろ強化)
- **IP-09**: slugify「14」/retry「11」→ 実 **15/12**
- **OP-05**: env「181」→ 実 **192**(減ってなく増えている)

→ **対応**: 数値は再カウント。特に IP-11・DS-01 は過大なので受入条件(半減目標等)の基準を実数に合わせる。

---

## 3. 具体的な誤記(そのままだと実装が失敗する)

- **ONB-01**: 関数名 `getActiveReasoningBackend()` は**存在しない**。実在は `getReasoningBackend()`(`reasoning-backend.ts:359`)。→ 本レビューで修正適用。
- **CO-03**: 「`financials_prev_fy` は文字列」は**誤り**。`customer/sbiss/customer.json:11` は**オブジェクト** `{revenue_jpy, profit_jpy, note}`(値は数値文字列)。
- **CO-05**: 対象パス `pipeline-templates/`(リポジトリ直下)は**存在しない**。正しくは `knowledge/product/pipeline-templates/`(99テンプレはここ)。
- **IP-02 の行番号 off-by-one**(pdf :17→:18 等): これは Fable が IP-01 実装時に各 fs import へ `eslint-disable` コメントを付け1行下がった**副作用**。IP-02 着手時は再確認要。
- 全般に file:line が 1–2 行ずれる傾向(調査転記であって都度検証でない兆候)。

---

## 4. Fable の直近作業による陳腐化

- **IP-01**: **FLAWED**。Fable が既に実装済み(`eslint.config.js:19-24` から scripts/libs-core を un-ignore、`:165-171` で child_process を**意図的に ban せず**30+の正当 spawn を明記)。計画本文は「もう存在しない状態」を記述し、Task 1.2/1.5 は child_process ban を要求し矛盾。→ 本レビューで status 注記を適用。**なお実装は lint gate が `.venv`/`knowledge/confidential/*.cjs` の `no-undef` で未 green の途中**(中断のため)。
- **UX-01/SU-04/DS-01/DS-05**: `presence/displays/concierge/`(UX-01 のエラー封筒と reduced-motion を既に実装)と `KyberionCharts.tsx`(chart primitives + ARIA を追加)の投入で「現状」が部分的に陳腐化。SU-04 の「chart greenfield」前提、DS-05 の「reduced-motion 全ゼロ」は要更新。

---

## 5. 未認識の計画間衝突・重複(計画が相互参照し損ねている)

- **UX-04 ⚔ SU-01(実衝突)**: 両者が同じ二値確認コード(`route.ts:1167-1215`)を**非互換の終状態**へ書き換える(UX-04=ボタン化 / SU-01=構造化プラン UI に置換)。どちらか一方をオーナーに。
- **HN-01 ≈ MO-05(重複大)**: 両者とも `resolveTaskModelHint` 追加 + `thinking:'adaptive'` ハードコード解消。統合すべき。
- **`detectRegressions()` を3計画が奪い合い**: OP-01 Task2 / OP-04 Task1 / AO-01 Task4 が同じ zero-caller 関数の配線を主張。単一オーナー化。
- **アラート sink**: OP-04(warn 通知)と AO-03(`ops-alert.ts`)が別々に構築。OP-04 は AO-03 に依存させる。
- **janitor cron**: KM-01 と AO-01 が二重主張(AO-01 は「協調」と注記済みだが単一オーナー要)。
- 正当な依存(UX-06↔ONB-03、DS-02..05→DS-01、SU-04→SU-01)は重複でなく順序制約。

---

## 6. CO 系の投機的過大スコープ(需要ゲート推奨)

CO は依存タワー: CO-05 → CO-04 → CO-03 → (CO-02) → CO-01。

- **CO-01 SOUND**(会社の集約 read-view、理念の runtime 配線)、**CO-02 は事実健全・スコープ投機的**(単一テナントの org 図の上に「CFO を雇う」宣言的ビルダー)。この2つが防御可能な土台。
- **CO-03 NEEDS-REVISION**(財務は文字列でなくオブジェクト=前提誤り。P&L/cashflow/budget/forecast は事実上ミニ ERP で「会計は作らない」の但し書きと矛盾)、**CO-04 FLAWED**(SA-05 の承認ゲート + AUTONOMOUS_MAINTENANCE_JUDGMENT の4軸を重複する RACI エンジンで、財務データもない単一運用者製品には問題に先行しすぎ)、**CO-05 NEEDS-REVISION**(パス誤り + 投機タワー依存)。
- → **対応**: CO-01/02 は保持。CO-03/04/05 は**バッチ確約でなく実需要でゲート**する。CO-04 は SA-05 / 判断基準文書との統合を検討。

---

## 7. 参照文書(Fable 直接レビュー)

- **FABLE5_AGENT_MODEL**: 原則の記述は Fable の実規範に忠実で正確。ただし「本改善計画群を執筆したエージェント(Fable 5)」「Fable 5 が自身の…誇張や創作でなく」は**著者誤記**(実際は Opus 起草)。第一原則への自己違反。→ 本レビューで修正適用。§0 のモデル階層記述は system 由来で正しいが、リポジトリ工学文書としてはやや宣伝的。
- **ORCHESTRATION_HARNESS_MODEL / AUTONOMOUS_MAINTENANCE_JUDGMENT**: 内容は妥当。ただし多数の計画を「原則をそのまま翻訳した」と述べる箇所は、上記の計画側の不正確さを踏まえるとやや強い。
- **project-vision-evaluation / COMPANY_OS_CONCEPT**: 診断は良い。COMPANY_OS_CONCEPT は CO-03/04/05 の投機性(§6)を自ら誘発している面がある。

---

## 8. 推奨アクション(優先順)

1. **§1 の8計画の「無い」主張を「部分実装あり+差分」に訂正**(実装者の誤誘導が最大の実害)。
2. **§3 の具体的誤記を修正**(ONB-01 関数名 / CO-03 財務型 / CO-05 パス)— 一部は本レビューで適用済み。
3. **§5 の衝突を解消**(UX-04 vs SU-01 のオーナー決定、HN-01 を MO-05 に統合、detectRegressions/alert/janitor の単一オーナー化)。
4. **§2 の数値を実測に更新**(特に IP-11・DS-01)。
5. **§4 の陳腐化を反映**(IP-01=実装済、concierge/charts 追加を UX/SU/DS に)。
6. **CO-03/04/05 を需要ゲート化**(バッチ確約から外す)。
7. **FABLE5_AGENT_MODEL の著者帰属を訂正**(適用済)。

---

## 9. 本レビューで適用した修正

**第1バッチ(事実誤記・著者帰属)**

- `FABLE5_AGENT_MODEL.ja.md`: 著者帰属を「Opus 起草・Fable 5 レビュー」に訂正。§0 のモデル階層記述を簡略化。
- `ONB-01`: `getActiveReasoningBackend` → `getReasoningBackend`。
- `CO-03`: 財務は文字列でなくオブジェクト(`{revenue_jpy, profit_jpy, note}`)である旨に訂正。
- `CO-05`: 対象パスを `knowledge/product/pipeline-templates/` に訂正。
- `IP-01`: 冒頭に「実装済み(スコープ fs 限定・lint 未 green 残課題)」の status 注記。

**第2バッチ(§1 の「無い/未配線」背景訂正 — 8計画)**

- `MO-04`: context pack は mission-workitem-dispatch 経路で配線済み、未配線は worker 経路のみ、とスコープ縮小。
- `MO-07`: severity は uncertainty_gate が一部消費、と訂正(二世界テーゼは維持)。
- `AC-03`: ShellDeploymentAdapter + env 自動登録は既存、実スコープは config 経路+承認、と訂正。
- `KM-03`: memory-promote-pending の bulk 消費が既存、と訂正(自動処理の不在が真の gap)。
- `OP-03`: Dockerfile は既に真の multistage、残る論点は COPY 範囲と compose の dev-only、と訂正。
- `OP-04`: operator-surface に health surface あり、「集約 endpoint とプッシュ通知が無い」に限定。
- `AO-01`: best-effort overlap ガード既存、真の run-lock へ格上げ、と訂正。
- `AO-03`: notify-slack は docstring 例で未配線、「そもそも sink が無い」が正確、と訂正。

**第3バッチ(§5 の衝突・単一オーナー化)**

- `UX-04`↔`SU-01`: chronos 二値確認の置換は **SU-01 が単独オーナー**。UX-04 の該当 Task を SU-01 へ委譲。
- `HN-01`↔`MO-05`: ルーティング機構(resolveTaskModelHint・thinking 解消)は **MO-05 が単独オーナー**。HN-01 は軽量モデル規律のみに縮小。
- `detectRegressions()`: **OP-04 が所有**(OP-01=cost 集計、AO-01=保守ループに分離)。
- janitor/GC cron: **KM-01 が所有**(AO-01 は他の配線に集中)。
- alert sink: **AO-03 が所有**(OP-04 が依存)。

**未適用(判断を要する — 指示待ち)**

- §2 の数値再カウント(IP-11 の `as any`、DS-01 のインラインスタイル等)。
- CO-03/04/05 の需要ゲート化(バッチ確約から外すか)。
- CO-04 の SA-05/判断基準文書との統合可否。
