---
title: パイプライン実行マニフェスト — 決定論パイプラインを1回の承認で動かす設計
tags: [governance, pipeline, external-operation, charter, approval, ux, tenant]
last_updated: 2026-11-26
status: active
concepts: [pipeline, run-manifest, run-principal, credential-custody, tenant]
runtime_stages: [alignment, execution]
---

# パイプライン実行マニフェスト

オペレーター本人が承認した定型パイプライン（例: テナント配下のブラウザシナリオ）を、手元の端末から1回の承認で流せるようにする。
同時に、自律ワーカーの実行に対する既存の守り（テナント隔離・資格情報の隔離・外部操作の1回限り実行と監査）は弱めない。

## 1. 何が壊れていたか

2026-10 に書かれた `run-approval-flow.json`（browser:goto / evaluate ×21 / fill / click、secret:get、core:if / while）は、2026-11 時点では次の順に止まった。

| 試行                     | 停止理由                                                              | 原因の層                                                            |
| ------------------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 準備                     | project-trust 承認が必要。承認画面に3種類のハッシュが出て分かりにくい | ファイル単位の信頼                                                  |
| エージェントから実行     | `[HUMAN_REQUIRED]`                                                    | 外部操作の承認（人の在席を TTY だけで判定）                         |
| 本人の TTY から実行      | `[EXTERNAL_REVIEW_SCOPE_REQUIRED]`                                    | レビュー証跡の保存先テナントが `KYBERION_TENANT` からしか決まらない |
| `KYBERION_TENANT` を付与 | `[CREDENTIAL_BINDING_REQUIRED]`                                       | `secret:*` を「推論資格情報が必要」と誤分類                         |
| その先                   | browser の各ステップが「承認必須・委譲不可」で約10回の個別承認        | ファイル承認とステップ承認が連動しない                              |

4つの層は、それぞれ別の問いに答えている。問題は層の数ではなく、**実行前に全ての問いへまとめて答える単位が無い**ことだった。
そのため、ゲートを1つ越えるたびに次の問いが初めて見つかった。

## 2. 1回の実行が答えるべき5つの問い

| 問い               | 答える概念                                 | 決まり方                                                                                         |
| ------------------ | ------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| 何を実行するか     | パイプライン定義（content hash）           | ファイルの SHA-256                                                                               |
| どこで（テナント） | 実行スコープ                               | **ファイルの置き場所から導出**する。`KYBERION_TENANT` は一致確認にのみ使い、権限の根拠にはしない |
| 誰が               | Run Principal                              | `attended`（本人が端末にいる）か `unattended`（ワーカー・常駐 Dot）                              |
| 何を使うか         | requirements                               | モデルを呼ぶかどうか・どの secret 参照を使うか（静的に判定）                                     |
| どこまで許すか     | Effect Manifest + マニフェスト束縛 Charter | 人が平文で承認した外部操作の一覧                                                                 |

この5つを実行前に1つの **Run Manifest** にまとめる。人が承認する対象と、実行時のゲートが照合する対象を、この1つにそろえる。

## 3. データモデル

```
PipelineDefinition (JSON, content_sha256, 置き場所)
  │ compileRunManifest()  — 静的解析のみ。副作用なし
  ▼
RunManifest
  scope         { tier, tenant_slug }        ← tenantOfPath / tierOfPath
  requirements
    model       boolean                      ← pipelineBootstrapNeeds().model（上限なしの走査。MODEL_OPS を含む）
    secrets     [secret 参照]                 ← secret:get の service/account。値は持たない
    effects     EffectManifestEntry[]
    browser_navigation  { allow_private_network: true }  ← options.navigation_policy が柵を緩めるときだけ
  manifest_hash

EffectManifestEntry
  entry_id              ステップの位置（step path）
  operation_id          browser:goto など
  target                静的 URL、または origin + path パターン
  origins               このステップが動いてよいページの origin
  argument_origins      static | secret:<ref> | step-output
  params_template_hash  作者が書いた（展開前の）params のハッシュ
  max_occurrences       while / loop_until の max_iterations から決まる上限
  script                evaluate / cdp: { sha256, length, excerpt(先頭200文字・空白圧縮) }
  secret_origins        secret 参照 → その値を入力してよい origin（直前の静的遷移先 1 つ）
  bindable              false: 参照ステップ・上限のないループ・テンプレート化されたホスト・
                        2000 文字超のスクリプト(script_not_presentable)・遷移前の secret
                        (secret_origin_unknown)・テンプレート/フレーム越えセレクタへの secret
                        (unsafe_secret_selector)・core:judge_route より後(judge_routed)
```

- **モデル要否**は `pipelineBootstrapNeeds().model` で決める。表示用の `reasons` は 8 件で切るが、`model` は全ステップを上限なしで走査した結果である。モデルを呼ぶのにモデル系ドメイン（`reasoning` / `wisdom` / `voice`）ではない op は `MODEL_OPS`（`browser:llm_decide`、`meeting:*` の要約系、`modeling:extract_*` など）に明示する。ランナーの資格情報判定（`installReasoningBackendsForSteps`）、manifest の `requirements.model`、`pipeline check` の `model` 行は同じ値を使う。
- **secret の origin** は、同じボディの中で直前にある静的な遷移（`browser:goto` / `open_tab`）の origin に束縛する。ネストしたボディは親のその時点の origin を引き継ぎ、遷移を含むボディの後ろでは origin は不明になる。manifest の origin 全体ではない。

### 3.1 承認とマニフェスト束縛 Charter

- **承認**は既存の project-trust 承認（`ApprovalRequestRecord`）を拡張する。payload は v2 = `{input_path, content_hash, manifest_hash, principal_modes, runs_per_day}` とし、v1 の承認も引き続き受理する。`runs_per_day` を持たない v2 の承認（上限の導入前に決裁したもの）も受理し、上限は既定の 20 とする。
- **1 日あたりの run 上限**（`runs_per_day`）は、承認を求める人が `--runs-per-day N` で決める（1〜1000。省略時は 20）。カードには「How often: at most N runs per day (UTC); later runs that day ask step by step」と平文で出し、`justification.requestedEffects` の `run-runs-per-day:<N>` と v2 payload の両方に載せる。決裁後に上限だけを変えることはできない（変えると payload と提示ダイジェストが変わり、別の承認要求になる）。
- 承認カードには、ハッシュではなく**マニフェストを平文で**表示する（「https://x/… を開く」「secret `garoon/…` を x 上の `#password` に入力する」）。ページスクリプトは件数ではなく、**異なるスクリプトごとに 1 行**（先頭 200 文字の抜粋・そのスクリプト自身の SHA-256 先頭 16 桁・使うステップ id・回数）を出す。2000 文字を超えるスクリプトはカードで判断できないので束縛しない（`script_not_presentable`、ステップごとの承認）。カードの文面（details）は提示ダイジェストに含まれ、スクリプトの SHA-256 は manifest_hash にも含まれる。カードのセレクタ名は、呼び出し側が渡したステップではなく、束縛するファイル内容そのものから読む。ハッシュは末尾の1行に寄せる。
- 承認済みの記録から、**Accountability Charter** を1つ発行する。
  - scope: 新しい種類 `{kind: 'run_manifest', tenant_slug, manifest_hash}`。組織 Charter とは名前空間が別なので、「スコープごとに有効な Charter は1つ」の規則とぶつからない。
  - 中身の grant: `{operation_id, manifest_hash, entry_id}` の形に限る。この形は `run_manifest` Charter にしか置けず、`run_manifest` Charter には他の形の grant を置けない（`validateCharter` で強制）。そのため、一般のエージェント権限には広がらない。
  - 有効期限: 承認日から 90 日と、承認自体の期限の早い方。ファイルが1文字でも変われば manifest_hash が変わり、Charter は使えなくなる。
  - 1 日の上限: envelope の `runs_per_day`（`money` と同じく envelope の上限。`run_manifest` Charter にしか置けず、1〜1000 の整数であることを `validateCharter` で強制）。上限の導入前の承認から発行した Charter はこの項目を持たず、数えるときに既定の 20 を使う。日の区切りは **UTC の暦日**（`money.per_day` と同じ。00:00 UTC で 0 に戻る）。数えるのは、同じテナント・同じ manifest_hash の全ての `run_manifest` Charter（置き換え済み・失効済みを含む）の台帳にある当日の `run_started` の、異なる run id の数である（`money` の使用量が lineage を合算するのと同じ考え方）。そのため、承認し直して Charter が置き換わっても当日の数は戻らず、カードの「1 日 N 回まで」を超えない。上限は今有効な Charter の `runs_per_day` を使う。
  - 再利用: 既に発行済みの Charter を使い回すときは、保存されたファイルの内容（受理時刻と lineage を除く正規化ハッシュ）が承認記録から導出し直した Charter と一致することを確かめる。一致しなければ `[RUN_MANIFEST_CHARTER_TAMPERED]` で拒否し、その run はステップごとの承認に戻る。
  - `listActiveCharters` は組織 / 個人の Charter だけを返す（日次レポート・委任判定などの利用者向け）。`run_manifest` Charter は `includeRunManifests: true` のときだけ列挙する。
  - 発行条件: 人が決裁し、認証済みで、提示した文面のダイジェストが検証済みで、決裁者がそのテナントの owner であること。エージェントは発行できない。
- **op 側の属性**: authorization registry に `manifestBindable` を追加し、`delegable` とは分ける。`delegable` は「常設 Charter でエージェントに委任できる」という今の意味のまま残す。

### 3.2 実行時の照合

外部操作ゲートは、承認の根拠を次の順で探す。

1. 埋め込み元が渡す権限（既存）
2. onboarding 用 Charter（委任可能な op だけ。既存）
3. **マニフェスト束縛 Charter** — 次の全てを満たすときだけ admit する
   - op がエントリと一致する
   - 展開前の params のハッシュがエントリと一致する（evaluate のスクリプトとセレクタも含む）
   - goto の展開後 URL がエントリの target に合う
   - ページ上で動く op は、現在の URL の origin がマニフェストの origins に入っている（リダイレクト先で承認済みスクリプトが走ることを防ぐ）
   - 実行回数が `max_occurrences` 以下である
   - 実行主体のモードが Charter の `principal_modes` に含まれる（既定は `attended` のみ）
   - secret を運ぶステップは、現在のページ（遷移なら遷移先）の origin がその secret の `secret_origins` に入っている
   - ランナーが展開済みの値を、actuator が二度目に展開していない（`params` と `requested_params` が一致する）。ランナーの葉 dispatch は `withRunnerResolvedParams` の中で行い、ブラウザ actuator は 1 ステップの非 control パイプラインではテンプレートを再展開しない。ページ由来の `"{{password}}"` という文字列が secret に化けることはない
4. ステップごとの承認（既存）。`attended` なら対話で確認し、`unattended` なら承認要求を登録して `PipelineRunJournal` で保留する。

admit された後も、次の処理は**ステップごとにそのまま行う**: レビュー証跡の書き出し、テナント tripwire による停止、予約と1回限りの commit、Charter の実行台帳、AuditChain への記録。

### 3.3 実装の入口（P2b）

| 役割                       | API                                                                                                                                                 | 置き場所                                       |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| v2 承認要求を開く          | `requestPipelineTrustWithManifest({inputPath, manifest, principalModes?})`                                                                          | `libs/core/project/project-trust.ts`           |
| v2 承認を探す              | `findValidRunManifestTrustApproval(inputPath, manifestHash)`                                                                                        | 同上                                           |
| Charter を発行する（冪等） | `ensureRunManifestCharter({approvalRequestId, manifest})`                                                                                           | `libs/core/governance/run-manifest-charter.ts` |
| 実行時の束縛               | `withRunManifestBinding({manifest, charterId, principal, runId}, body)` と、葉ステップごとの `withRunManifestStep({entryId, authoredParams}, body)` | `libs/core/governance/run-manifest-binding.ts` |

- v2 の束縛は `accountability.payloadHash`（v2 payload）と `justification.requestedEffects`（`run-manifest:<hash>` / `run-principals:<modes>`）の両方に載る。後者は提示ダイジェストに含まれる。
- 承認カードの `details` にマニフェストの平文行を載せ、ハッシュは末尾の `Binding:` 1 行にまとめる。`unattended` を有効にした要求は、要約に `UNATTENDED RUNS ENABLED` と出す。
- `run_manifest` Charter は `acceptCharter` では作れない。`issueRunManifestCharter` だけが、承認記録を承認ストアから読み直して検証（人・認証済み・提示ダイジェスト検証済み・v2・manifest_hash と content hash の一致・テナント owner）したうえで、Charter の全項目を導出して書く。
- 評価の核（`evaluateAgainstCharter`）は次の3点を強制する。`run_manifest` Charter はマニフェスト操作以外を admit しない。マニフェスト操作は `run_manifest` Charter 以外では admit されない。実行主体は `principal_modes` に含まれなければならない。
- 実行回数は、束縛ごと・エントリごとに admit を試みた回数で数える（照合に失敗した試行も数える）。ADF の中でブラウザ actuator の内側に展開されるボディ（`browser:while` / `browser:if` の中身）には、ランナーが `withRunManifestStep` を付けられない。そのため、ADF ではそれらはステップごとの承認に戻る。ブラウザ actuator の native 形式のファイルでは actuator 自身がランナーなので、同じボディにも entry id を付ける（§3.5）。

### 3.4 ランナーへの組み込み（P2c, 実装済み）

外部から使う入口は 2 つの既存形のサブパスにまとめる: `@agent/core/pipeline/run-manifest`（compiler・session・run scope・Run Principal・readiness をまとめて再 export する `run-manifest-api.ts`）と、束縛・grant API を再 export する既存の `@agent/core/governance/external-operation-runtime`。

| 場所                                                                                 | 何をするか                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `libs/core/pipeline/run-manifest-session.ts`                                         | `compilePipelineFileRunManifest`（読み込んだ正確なテキストの SHA-256・置き場所のスコープ・`context`・`options` から compile）、`requestPipelineFileTrust`（v2 要求。workflow module など manifest を作れないファイルは v1）、`openRunManifestSession`（実行開始時の束縛の判断。失敗しても run は止めず、理由を 1 行で返す）             |
| `pnpm kyberion project-trust request <path> [--allow-unattended] [--runs-per-day N]` | v2 要求を開く。`principal_modes` は既定で `['attended']`、`--allow-unattended` で `unattended` を足す。`runs_per_day` は既定で 20、`--runs-per-day N`（1〜1000）で変える。playground の `--request-trust` も同じ関数を使う                                                                                                              |
| `scripts/pipeline/pipeline-execution-part-manifest.ts`（呼び出しは `-results.ts`）   | CLI（`runPipelineInput`）とライブラリ（`executePipelineFile`）の両方で、trust 確認後・スコープ envelope の内側で manifest を再 compile し、`resolveRunPrincipal`（CLI は `resolvePipelineHumanPresence`、ライブラリは `options.hasHuman`）→ `findValidRunManifestTrustApproval` → `ensureRunManifestCharter` → `withRunManifestBinding` |
| `scripts/pipeline/pipeline-execution-part-control.ts`（`prepareEngineSteps`）        | 各ステップに Symbol キーで entry id（compiler と同じ `3` / `2.pipeline.0` / `4.cases.1.steps.0` / `5.on_error.fallback.0`）と**展開前の** params を付ける。Symbol なので JSON（journal・action 入力）には出ず、偽造もできない。葉の actuator dispatch を `withRunManifestStep` で包む                                                   |
| `scripts/pipeline/pipeline-execution-part-execution.ts`                              | ネストしたボディ（`then`/`else`/`pipeline`/`do`/`calls`/`cases.N.*`/`default`）の entry prefix を親から引き継ぐ。`core:include` の断片には付けない                                                                                                                                                                                      |

束縛できたそれぞれの run は、Charter の台帳に `run_started`（run id・principal・manifest hash）として 1 行残す（`recordRunManifestRunStarted`、run id ごとに冪等）。記録できなければその run は束縛しない。

同じ関数が 1 日の上限も守る。Charter の決定ロックの中で当日（UTC）の `run_started` を数え、上限に達していれば何も書かずに `recorded: false` を返す。`openRunManifestSession` はその run を束縛せず（run は止めない。全ての外部ステップがステップごとの承認に戻る）、`run manifest: not bound — daily run cap reached (N/N today, UTC <日付>) | next: run again after 00:00 UTC, or re-approve with a higher cap: pnpm kyberion project-trust request <path> --runs-per-day <N>` を 1 行出す。同じ UTC 日にこの Charter へ記録済みの run id はもう一度数えずに束縛する。前の日に記録した run id は、その日の 1 回として数え直す（呼び出し側が渡す run id を使い回して数えずに通ることはない）。時刻は `now` 引数で差し替えられる。

外部操作ゲート（`resolveRunManifestCharterAuthority`）も、束縛の run id がその Charter の台帳に同じ UTC 日の `run_started` として記録されていることを確かめる。記録がなければ admit せず、ステップごとの承認に戻る。`withRunManifestBinding` は `@agent/core/governance/external-operation-runtime` から公開されているので、プロセス内の呼び出し側が記録せずに束縛を張って上限を飛ばすことを防ぐためである。確認は束縛ごとに最初の 1 回だけ行い、結果を覚える（ステップごとに台帳を読まない。0 時をまたいだ run も、確認済みなら続けて admit される）。最初の外部ステップの前に 0 時（UTC）を越えた run は、ステップごとの承認に戻る。

`withRunManifestStep` を付けられないディスパッチ（include の断片やツール呼び出しなど、タグのないステップ）は、外側のステップの entry id を引き継がないよう `withoutRunManifestStep` の中で実行する。

実行開始時に 1 行出す: `run manifest: K/N external steps pre-approved (charter <id>, principal attended)`、または `run manifest: not bound — <理由> | next: <コマンド>`。tenant のないパイプラインと workflow module は debug に落とす。

### 3.5 ブラウザ actuator の native 形式（実装済み）

テナントのブラウザシナリオの多くは ADF ではなく、ブラウザ actuator の native 形式で書かれている: `{action: 'pipeline', session_id, options, context, steps: [{type, op: 'goto', params}]}`。op に `browser:` が付かず（`goto` / `fill` / `if` / `while`）、ステップの `type`（capture / apply / control）でエンジンが振り分ける。以前の compiler はこれを ADF として読み、外部ステップを 0 件と数えていた。そのため事前承認できず、外部ステップが 1 つずつ承認を求めた。

| 場所                                                                                 | 何をするか                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `libs/core/pipeline/run-manifest-native.ts`                                          | 判定（`isNativeBrowserPipelineDocument`: `action: 'pipeline'`、全ステップに `type` があり、op が bare か `browser:` 付き、bare が 1 つ以上）と、`browser:<op>` に読み替えた見え方（`nativeBrowserManifestSteps`。`if` の `then`/`else`、`while` の `pipeline`、`on_error.fallback` まで）。全 op が `browser:` 付きのファイルは `pnpm pipeline` で動くので ADF として扱う                                                                                                                                    |
| `compileRunManifest(..., {format: 'browser_native'})`                                | ファイル全体を 1 つのブラウザボディとしてコンパイルする。外部操作かどうかは catalog ではなく作者が書いた `type` で決める（native エンジンと同じ）。params のハッシュは書いたままの params で取る（ADF の `produces`→`export_as` の付与などはしない。`runtimeShapedAuthoredParams` の同じ実装に format を渡す）。`source.format: 'browser_native'` が manifest_hash に入る                                                                                                                                    |
| `loadPipelineFileRunManifest` / `pnpm kyberion project-trust request <file>`         | native ファイルを判定して native として compile する。承認カードに `Runner: the browser actuator (native browser pipeline)` を出す                                                                                                                                                                                                                                                                                                                                                                           |
| `libs/actuators/browser-actuator/src/browser-native-run-manifest.ts`                 | `runNativeBrowserPipelineFile`: 置き場所からスコープを導出し、テナントの envelope の中で `openRunManifestSession`（`format: 'browser_native'`）を開く。束縛できれば `withRunManifestBinding`、セッションのゲートストア（`withGateStore`）、`withPipelineRunSession` を張る。束縛できなければ（承認なし・変更後・スコープ不明・テナントなし）今までどおり何もせずに走らせる                                                                                                                                   |
| `browser-pipeline-helpers.ts` の `executePipeline`                                   | 束縛された run の最初の実行だけが、ファイル自身のステップとして claim する。ステップのコピーに Symbol で entry id（`3` / `2.then.0` / `4.pipeline.1` / `5.on_error.fallback.0`）と書いたままの params を付け、エンジンの `withStep` で各ステップを `withRunManifestStep` と外部操作の実行時 authority（ランナーと同じ）で包む。同じ run の 2 回目以降の実行は `withoutRunManifestStep`                                                                                                                       |
| `libs/core/pipeline/adf-engine.ts` の `AdfRunOptions.withStep`                       | ハンドラの dispatch をステップごとの非同期コンテキストで包む口。ネストしたボディと fallback にも効く                                                                                                                                                                                                                                                                                                                                                                                                         |
| 入口: `node dist/libs/actuators/browser-actuator/src/index.js --input <file>`        | `runActuatorCli` の `withInputFile`（読んだ正確なテキストと repo 相対パス）から束縛する。`--dry-run` / `--serve` には使わない                                                                                                                                                                                                                                                                                                                                                                                |
| 入口: `pnpm kyberion browser run --adf <file>`（`scripts/run_browser_procedure.ts`） | ファイルを読んだ呼び出し元のコンテキストで束縛を判断する。dispatch は束縛の有無にかかわらず `surface_runtime` で行い、identity を切り替えない。束縛されない run は options も書き換えない。admit する run（実行主体が承認済みのモードに入り、`run_started` を記録できた。`RunManifestSession.admitting`）でも、外部操作ゲートが読み書きするテナントの governance 状態は、セッションのゲートストア（下の「ゲートの読み書き」）だけを通る。そのため束縛しても、run が読める範囲は束縛されない run と同じである |
| `pnpm pipeline check <file>`                                                         | native ファイルは ADF として検証せず、`browser:*` に読み替えて static 行を出し、native manifest で `effects` 行を出す。`trust` 行: native ファイルはファイル信頼なしで走るので、承認がなければ blocked ではなく warning（`no approved manifest … every external step asks`）。承認済みなら `next: pnpm kyberion browser run --adf <file>`。v1 承認は見ない                                                                                                                                                   |

- **束縛された run が使う options。** ファイルの `options`（と `--headed` などの入口のフラグ）を同じ分類器（`classifyPipelineBrowserOptions`、ファイルの置き場所のスコープ）に通した値だけを使い、適用しない項目は run ごとに 1 回警告する（§8）。カードに出るのも同じ値である。束縛されない run は、従来どおりファイルの options をそのまま使う。パーティション外の `user_data_dir`（例: `active/shared/runtime/browser/<名前>`）は落とす。
- **暗黙のプロファイル。** ブラウザは `user_data_dir` がなくてもセッションごとに `runtime/browser/<session_id>`（未指定なら `default`）へプロファイルを残す。つまり永続プロファイルを使っている。束縛された run（native と ADF の両方）では、適用する `user_data_dir` がなければ `active/shared/runtime/browser/profiles/<tier>/<tenant>/session-<session_id>` を使い（単純な名前でない session_id は SHA-256 の先頭 16 桁）、カードに `Browser: uses the persistent profile … of browser session "<id>"` と出す。`navigation_policy.allow_data_url` もカードに出す。束縛されない run は従来どおりである。
- **ファイルの置き場所。** 束縛された native run のステップが書くファイル（`screenshot` / `export_session_handoff` / `export_playwright` / `export_adf` / `export_failure_bundle` の `path`。一覧は `NATIVE_WRITE_PATH_OPS`）の書き込み先は、`evidence/browser/`（既定のスクリーンショット先。束縛されない `browser run --adf` の `surface_runtime` も書ける）、`active/shared/tmp/<tier>/<tenant>/browser/`、`active/shared/artifacts/<tier>/<tenant>/browser/` の下である。
  - compiler はこれを**承認前に**判定する（`nativeWritePath`）。リテラルのパスで、上の下にあれば束縛できる。テンプレートが最後のファイル名だけにあり、ディレクトリがリテラルで上の下にある場合も同じ扱いにする。それ以外（外のパス・ディレクトリのテンプレート・絶対パスや `..`・既定が共有 tmp の export）は `browser:write_file` のエントリを足し、`write_path_unconfined` で束縛しない。カードには `Will still ask per step: step N writes <path> outside the run's partition — to pre-approve it, write it under active/shared/tmp/<tier>/<tenant>/browser/<file>` と出る。`pnpm pipeline check` も `effects` 行の details に同じ置き換え先を出す。
  - 実行時、そのステップは書く前に `browser:write_file`（認可レジストリで宣言済み。manifest では束縛できず、委任もできない）を 1 回求める。その効果には解決済みの正確なパスが入る。人が承認すると、そのステップで書けるのはそのパスだけである。つまり範囲外の書き込みは、人がステップごとにパスを見て決めることになる。承認がなければ、それまでの事前承認済みのステップは進み、そのステップで `EXTERNAL_APPROVAL_REQUIRED` で止まる。何も書かない。
  - compiler が範囲内と判定したステップが実行時に範囲外へ解決したとき（ファイル名のテンプレートが `../` を含むなど）は、多重防御として `[BROWSER_RUN_PATH_CONFINED]` で止める。
  - パスはリポジトリの境界（`assertSafeRepositoryPath`）を通す。この境界は途中のどこかにシンボリックリンクがあれば拒否する（末端も含む）。そのため、パーティションの判定は字面のパスで行っても実体の場所と一致する。
  - `import_session_handoff` は読み込んだファイルの cookie・storage・追加 HTTP ヘッダーを全ての origin に入れる。manifest では束縛しない（認可レジストリで `manifestBindable` を持たず、`not_manifest_bindable`）。束縛中は、`path` は run 自身のパーティション（`active/shared/runtime/browser/profiles/<tier>/<tenant>/` と、`tmp` / `artifacts` の `<tier>/<tenant>/browser/`）の下だけを読む（一覧は `NATIVE_READ_PATH_OPS`）。以前は `active/shared/runtime/browser/` 全体を読めたが、そこには他のテナントのプロファイルもあり、`surface_runtime` はそれを読める。判定はファイルを見る前（存在の確認より前）に行い、シンボリックリンクは拒否する。
  - `pause_for_operator` の `continue_file` は `active/shared/runtime/browser/` の下だけを読む。ブラウザ op にダウンロードやアップロードの元ファイルを指定するものはない。
  - 束縛中は外部のブラウザに CDP でつながない。CDP の options は分類で落ちる。同じ `session_id` に記録された CDP の接続先にも再接続せず、プロセス内に残る外部接続のセッションは `[BROWSER_BOUND_SESSION_EXTERNAL]` で使わない。
  - 試験（`browser-native-admission-table.test.ts`）は、エンジンが振り分ける全ての handler（capture / transform / apply の map と control op）のソースを機械的に走査する。そして、ステップの指定するファイルに触れる handler が、書き込み一覧・読み込み一覧・理由付きの例外（`json_query` の JSON パスなど）のどれかに入っていることを確かめる。走査が全ての op を見たことも確かめるので、新しい op は抜けられない。
- **ゲートの読み書き（2026-11-26）。** 束縛された run は `surface_runtime` のまま動くので、外部操作ゲートが要るテナントの governance 状態を自分の権限では読めない（以前は `[EXTERNAL_CHARTER_UNAVAILABLE]` で止まり、そのために呼び出し元の identity へ切り替えていた）。
  - admit するセッションだけが `withGateStore` を持つ。native ランナーは束縛（`withRunManifestBinding`）の中でそれを張る。開けるのは、その run 自身の束縛の中（run id と manifest hash が一致）だけである。テナントは置き場所から導出した RunScope のもので、manifest のテナントと一致しなければならない。別のテナントに束縛された呼び出し元は `[ROLE_TENANT_SCOPE_MISMATCH]` で拒否する（`libs/core/governance/run-manifest-gate-runtime.ts`。呼べるのは `run-manifest-session.ts` だけで、import 境界の試験で守る）。
  - 張っている間、ゲートの読み書きは 1 回ずつの同期した grant を通す（`run-manifest-gate-store.ts` と `foundation/run-manifest-gate-store-capability.ts`。PR 公開の store grant と同じ形）。種類と範囲は次のとおり。`charter-read`: そのテナントの `charters/` 直下の Charter と台帳（常設の tripwire の確認）と、束縛した manifest の `charters/run-manifests/<hash>/`。`charter-ledger-write`: その manifest の台帳への追記。`review-write`: そのテナントの `evidence/external-operation-review/<invocation>-<effect>.json` と artifact 索引。`reservation-write`: そのテナントの外部操作の予約。別テナント・別 manifest・テナントの他の knowledge・governance 以外のファイルは、どの種類にも入らない（範囲外のファイルを渡すと grant を発行しない）。grant の間は、その I/O の全てがこの範囲に絞られる（tier-guard の narrowing）。呼び出し元の role（`surface_runtime`）は変えず、テナントだけをその run のものに束ねる。
  - 発行の権利は `run_manifest_gate_store` である（role-assumption-policy の `shared_core_roles`。role としては引き受けられない）。承認の記録（ステップごとの承認要求）は既存の `tenant_approval_store` grant を通り、監査は監査チェーン自身が書く。
  - actuator CLI の `--input` は、もともと束縛の有無で identity を切り替えない（そのプロセスの identity のまま）。ゲートの読み書きは同じゲートストアを通る。
- **回数。** `while` のボディは `max_iterations`（0 以上の数。それ以外は 100）回まで。各回の各ステップは actuator の既存の occurrence（`browser-substep:<n>`）で区切られるので、1 回限りの予約は衝突しない。
- **`{{env.X}}` は資格情報。** native 形式で文書化された資格情報の渡し方であり（ランナーもブラウザのエンジンも、外部操作の効果を組み立てる前にプロセス環境から展開する。ADF でも同じ）、`secret:get` の値と同じに扱う（`argument_origins` は `secret:env/<NAME>`）。その値は、そのステップの直前の静的な遷移先 1 つにしか入力できない（`secret_origins`）。遷移前・テンプレートやフレームを越えるセレクタへの入力は束縛しない。カードは `Type the value of environment variable <NAME> (credential) into …` と出し、`Secrets:` 行にも載せる。他のステップが資格情報を運ぶときも、その行に `— carries …` を足す。URL に資格情報（env でも secret でも）を含む遷移は束縛しない（`credential_in_url`）。
- **束縛しないもの。** `ref` の中身（ファイルの外のステップ）と、同じ run の中で actuator が内部で起こす別の実行は、entry を持たずにステップごとの承認に戻る。
- **形式の判定はどこでも同じ。** 承認・`pipeline check`・実行時は同じ `isNativeBrowserPipelineDocument` を使う。全 op が `browser:` 付きのファイルを browser actuator で実行しても束縛せず、その理由（ADF として承認されること）を 1 行出す。`pnpm pipeline --input <native file>` は bare op を別ドメインとして読んでしまうので、`[PIPELINE_NATIVE_BROWSER] … | next: pnpm kyberion browser run --adf <file>` で拒否する。
- **entry id は配列の位置。** 形の壊れたステップ（オブジェクトでない・`op` がない）も位置を占め、compiler と実行時（`prepareEngineSteps`、native のタグ付け）の entry id はずれない。
- 検証: `libs/core/pipeline/run-manifest-native.test.ts`（native の形の compile、判定、`{{env.X}}`、配列位置、暗黙のプロファイル、check の行）、`libs/actuators/browser-actuator/src/browser-native-run-manifest.test.ts`（actuator のエンジンと実際の `if`/`while` ハンドラ・fallback で、実行時の entry id と params のハッシュが compiler と一致 / admit しない束縛では何も切り替えない / ADF と判定するファイルは束縛しない / 書き込み先の閉じ込め）、`browser-native-admission-table.test.ts`（各 type の handler map と control op の全 61 件で、実行時に外部操作ゲートを通る op は必ず manifest の効果になる）、`scripts/pipeline/pipeline-native-route.test.ts`（`pnpm pipeline` の拒否）、`scripts/pipeline/pipeline-run-manifest-native.e2e.integration.test.ts`（headless Chromium と loopback ページで、`pnpm kyberion browser run --adf` から v2 承認 1 回・個別承認 0 件で完走。パスワードは `{{env.X}}` から入る / 1 バイト変更で束縛されず、最初の goto が承認を求めて止まる / attended のみの承認は owner の端末で通り、unattended では通らない / 束縛された run の dispatch は `surface_runtime`）、`libs/core/tier-guard/tier-guard-run-manifest-gate-grant.test.ts`（ゲートストアの範囲: 別テナント・別 manifest の Charter や台帳、テナントの他のファイルは読めない / 範囲外のファイルには grant を発行しない / 広い呼び出し元も grant の間は範囲に絞られる / その run 自身の束縛の中でしか開けない）、`tests/run-manifest-gate-store-capability-boundary.test.ts`（発行口の import 境界）、`browser-native-run-manifest.test.ts`（`surface_runtime` で動く束縛された run は、呼び出し元なら読める別テナントの handoff・プロファイルを読めない）。

## 4. Run Principal と資格情報

| principal    | 条件                                                                                                                                                                                                                              | 推論資格情報                                                                                     | 範囲外の外部操作       |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------- |
| `attended`   | TTY があり（ライブラリ呼び出しでは `hasHuman: true`）、エージェントが動かしているプロセスではなく、loopback で有効なメンバーに解決でき、そのメンバーが束縛する Charter の accountable（承認した owner）か宣言済みの deputy である | モデルが必要なときだけ。既存の custody 判定（`personal_owner` か、テナントが持つ資格情報）を通す | 対話で承認する         |
| `unattended` | それ以外                                                                                                                                                                                                                          | WorkItem の claim による TaskCredentialBinding（既存）                                           | 承認を登録して保留する |

- **エージェントが動かすプロセスは attended にならない。** 判定は `detectAgentExecutionContext`（`libs/core/agent/agent-execution-context.ts`）を再利用する。Kyberion のエージェント実行（`KYBERION_AGENT_ID` / `KYBERION_NHI_ID` / `KYBERION_RUN_ORIGIN=agent`）、reasoning-provider registry が宣言する provider CLI の印（`CLAUDECODE`、Codex / Gemini / agy などの `session_markers`）、`AI_AGENT` のどれかがあれば unattended（理由 `agent-driven process`）。terminal-actuator が起動する PTY には `KYBERION_RUN_ORIGIN=agent` を必ず付ける（呼び出し側の env では外せない）。印は助言的で、無いことは人がいる証明にならないが、有れば attended を拒む根拠として十分である。
- ライブラリ呼び出しの `hasHuman: true` も同じ判定を通る。`hasHuman` だけで attended にはならない。
- メンバーと Charter の accountable の照合は束縛時（`openRunManifestSession`、Charter 発行の後）に行う（`principalForAccountable`）。`pnpm pipeline check` の `principal` 行は、unattended の理由（例: `unattended (agent-driven process (agent:claude-code))`）と次の手を出す。

`attended` だからといって、資格情報の例外は作らない。
サブスクリプショントークンを使えるかどうかは、「誰が実行するか」ではなく「誰の仕事か」で決まる。個人の Pro/Max は `personal_owner` が本人のテナントにだけ貸せる。根拠は `credential-custody.ts` と [CLAUDE_CLI_TENANT_CREDENTIAL_DESIGN](../../../docs/developer/improvement-plans-2026-11/CLAUDE_CLI_TENANT_CREDENTIAL_DESIGN_2026-11-16.ja.md) にある。
モデルを呼ばない決定論パイプラインは、そもそも資格情報を必要としない。

## 5. UX: `pnpm pipeline check <file>`

既存の `--dry-run` レポート（`assessPipelineDryRun`）を拡張し、全てのゲートを実行前にまとめて評価する（`libs/core/pipeline/pipeline-readiness.ts`）。2026-11-25 時点の実出力（スクリプトを args で渡す evaluate を含む while ループと、実行時に決まる URL を 1 つ含むシナリオ）:

```
$ pnpm pipeline check knowledge/confidential/default/scenarios/run-manifest-smoke.json
[pipeline-check] blocked: run-manifest-smoke
 ✓ scope       tenant default (confidential; derived from the file location)
 ✗ trust       not approved — a project-local pipeline needs a human project-trust approval
               next: pnpm kyberion project-trust request knowledge/confidential/default/scenarios/run-manifest-smoke.json, then pnpm kyberion approve <request-id> project-trust
 ✓ model       not needed (deterministic steps only)
 ✓ secrets     smoke/approver (references only — values are never read; existence is not checked)
 ! effects     5 external step(s), 4 pre-approvable; per-step approval: 5 browser:goto (templated_host)
               next: keep URLs literal, page scripts static (pass run-time values through evaluate args) and step files inside the run partition to make a step pre-approvable
 ! principal   unattended (no terminal present) — steps outside an approved manifest will suspend
               next: run from an interactive terminal
 ✓ static      8 contract check(s) pass
```

- `effects` は Run Manifest の網羅率（外部ステップ数・事前承認できる数・できないステップと理由・manifest に入らない include などの理由）。manifest を作れないとき（workflow module・スコープ未導出）は従来の件数表示に戻る。
- `trust` は、この manifest に束縛された v2 承認があれば `approved (manifest <短縮ハッシュ>; <id>; 3/20 runs today)` で pass（当日 UTC の run 数と上限。Charter が未発行なら 0 と承認の上限。読めなければ件数を省く）。上限に達していれば `daily run cap reached` の warning と次の手（00:00 UTC 以降に実行するか、`--runs-per-day` を上げて承認し直す）を出す。check は Charter を発行しない（`runManifestApprovalRunUsage`）。v1 承認しかなければ `approved without manifest — every external step will ask; re-request: …` の warning、どちらもなければ blocked。束縛できる外部ステップが無いパイプラインは v1 でも pass。

- `effects` は、テンプレートを埋め込んだページスクリプト（`templated_script`）ごとに 1 行、そのまま貼れる書き換え案を出す（`libs/core/pipeline/run-manifest-args-suggest.ts`）。書き換えは作者が手でしていたものと同じで、スクリプトを `(a) => …` の page function にし、埋め込みを `a.<名前>` に置き換え、`"args": {"<名前>": "{{<名前>}}"}` で値をデータとして渡す。例: `"script": "(() => '{{target}}'.split(' | ')[0])()"` → `step 7: "script": "(a) => String(a.target).split(' | ')[0]", "args": {"target":"{{target}}"}`。
  - 機械的に意味が変わらない形だけを書き換える: 文字列リテラルそのものが `'{{x}}'`（→ `String(a.x)`）、長いリテラルの一部 `'id-{{x}}'`（→ `('id-' + String(a.x))`）、値の位置の素の `{{x}}`（→ `a.x`）。包み方は `(() => 本体)()`・`(async () => …)()`・`(function () { … })()`、または 1 つの式（`(a) => (式)`）。`{{a.b}}` / `{{items[0]}}` は引数名を `a_b` / `items_0` にし、値は元のテンプレートのまま。名前が重なれば `_2` を付け、スクリプトが `a` を使っていれば `args` などの空いた名前を使う。
  - 同値性: 文字列の位置ではスカラー値（文字列・数値・真偽値・null）で元の展開結果と一致する。未設定の変数は、展開でも args でも空文字列になる（テンプレートだけの値は `undefined` ではなく `""` に解決される）。オブジェクトは展開すると JSON、`String()` では `[object Object]` になるので一致しない（ページスクリプトでは稀）。素の位置の `{{x}}` → `a.x` は一般には一致しない: 元はテキストをコードとして読み、書き換え後は context の値をデータとして受け取る。context の文字列 `"42"` は数値 42 ではなく文字列のまま届き、未設定は構文エラーではなく `""` になる。context の値がコードの期待する JSON の型を既に持つときだけ同じに動く。案には毎回この注意を 1 行添える（`ARGS_SUGGESTION_CAVEAT`: 比較は `String(...)` で）。
  - 資格情報は args に移さない: `{{env.X}}` と `secret:get` が export する変数は、ページスクリプトにデータとして渡ることになるので案を出さず、理由を出す。
  - 安全に書き換えられない形は案を出さず、理由を 1 行で出す: 正規表現・テンプレートリテラル・コメントの中のテンプレート、名前付き関数や引数付き呼び出しなど未知の包み方、文の並び、`this` / `arguments`、素の位置の既定値付き `{{x|0}}`（型が変わる）、`{{@…}}` パス、オブジェクトのキー、識別子への連結（`id{{x}}`）、エスケープ直後のテンプレート、`}` の後の `/`（割り算か正規表現か決まらない）、既に `args` を持つステップ。スクリプトはコンパイルも実行もせず、小さな字句解析器で判定する。書き換え後も 2000 文字を超えるなら、その旨を添える（`script_not_presentable` のまま）。
  - `pnpm pipeline check <file> --suggest-args` は、テンプレートを含む evaluate ステップごとに 1 行（貼り付け用の `script` と `args`、または案を出さない理由）を標準出力に出す（`--json` では結果の配列）。ファイル全体を出し直すことはしない。JSON として読み直して書き出すと、大きな整数・重複キー・書式が黙って変わるためである。ファイルには書かない。

### 5.1 `pnpm pipeline fix <file>`（機械的な書き換え）

check が出す直し方のうち、判断の要らない 3 つを owner が 1 回のコマンドで当てる（`libs/core/pipeline/pipeline-fix.ts`、`scripts/pipeline/pipeline-fix-command.ts`）。テナントのファイルを書き換えるので、owner が自分の端末で実行する。書き込みは呼び出した本人の identity とスコープで行い、tier / テナントの書き込み規則がそのまま効く。拒否されたら診断を出して止まり、迂回しない。

| 直すもの                                                                              | 書き換え                                                                                                 | 書き換えないとき（`manual`）                                                                          |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `templated_script` の evaluate                                                        | `run-manifest-args-suggest.ts` の案（`(a) => …` + `args`）。注意（`ARGS_SUGGESTION_CAVEAT`）を毎回添える | 案を出さない形（資格情報、正規表現の中、未知の包み方など）。理由をそのまま出す                        |
| native のステップのファイル（`write_path_unconfined`）                                | compiler の `suggested_path`。`path` を書いていないステップ（既定の書き込み先）には `path` を足す        | 元のパスが他の値にも出てくる（後のステップが読むなど）、別のファイルが同じ名前に重なる、params がない |
| パーティション外の `options.user_data_dir`（分類器 `classifyPipelineBrowserOptions`） | `active/shared/runtime/browser/profiles/<tier>/<tenant>/<フォルダ名>`                                    | テンプレート、文字列でない、フォルダ名が単純な名前でない                                              |

ADF では compiler が `write_path_unconfined` を出さない（ステップのファイルを閉じ込めるのは native run だけ）ので、2 は native ファイルだけに当たる。

- **既定は dry run。** 前後の網羅率（`N of M external step(s) pre-approvable → after fix: K of M`）、直すステップごとの前後と再コンパイル後の状態、`manual` の理由、残るステップごとの承認、unified diff（長い行は省略表示。`--json` は書き換え後の全文を含む）、次のコマンド（`--write`、書き換え後の `project-trust request`）を出す。出すのはファイル自身の内容だけで、secret の値は読まない。
- **ファイルを読み直して書き出さない。** `JSON.parse` / `stringify` を往復すると、大きな整数・重複キー・書式が黙って変わる。小さな走査器（`json-source-edit.ts`）で値の位置を記録し、対象の値だけを置き換え・挿入する。それ以外は 1 バイトも変えない。重複キーのあるファイルはどちらが効くか読み手によって違うので、`[PIPELINE_FIX_DUPLICATE_KEYS]` で拒否する。
- **書き込みを拒否する条件。** 書き換え後のファイルを再コンパイルし、(1) 事前承認できる数が減る・ステップごとの承認が増える・manifest が不完全になる、(2) 対象の値以外が構造上変わる（元と書き換え後をパースして比べる）、(3) ADF として検証できない・形式（ADF / native）が変わる、のどれかなら書かない（`refused`）。
- **`--write`。** 読んだ時点の SHA-256 と、書く直前の内容を比べ、違えば `[PIPELINE_FIX_CHANGED]` で止める。書く前に元のバイト列をファイルの置き場所のパーティションの artifact フロアへ残す（`active/shared/artifacts/<tier>/<tenant>/export/pipeline-fix-backup/<名前>.<時刻>.json`、`writeScopedArtifact`、`create_only`）。ファイルの隣（knowledge の中に `.bak` が知識として残る）や 24 時間で消える tmp フロアには置かない。書いた後は、新しい内容に対して `project-trust request` からやり直す（内容が変われば承認は無効）。
- **`--move-profile`。** 書き換える `user_data_dir` の既存のプロファイルを新しい場所へ移す（`safeMoveSync`）。移せるのは `active/shared/runtime/browser/`（`profiles/` の下を除く）と `active/shared/tmp/` の下（別のテナントのパーティションを除く）のディレクトリだけで、移し先が既にある・ブラウザが開いている（`SingletonLock`）ときは拒否する。dry run では何を移すかだけを出す。移した後にファイルを書けなければ元に戻す。
- `pnpm pipeline check` は、同じ planner が書き換えを見つけたとき、`effects` / `browser` 行の `next` に `pnpm pipeline fix <file>` を出す。
- 検証: `libs/core/pipeline/pipeline-fix.test.ts`（ADF と native の合成ファイルで、書き換え・大きな整数と書式の保存・資格情報の evaluate は `manual`・参照されているパスは `manual`・重複キーの拒否・別テナントのプロファイルは移さない）、`scripts/pipeline/pipeline-fix-command.test.ts`（dry run の網羅率と差分、`--write` のバックアップ、読んだ後の変更で拒否、`--move-profile` の dry run / 移動 / 移し先が既にあるときの拒否、check の `next`）。

足りないものは全て、次に打つコマンドと一緒に出す（診断形式 `what — why | next`）。

## 6. 実装段階

| 段階 | 内容                                                                                                 | 主なファイル                                                                                                                                                      |
| ---- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0   | `secret:*` を推論資格情報が必要な理由から外す                                                        | `libs/core/reasoning/pipeline-bootstrap-needs.ts`, `scripts/pipeline/pipeline-execution-part-results.ts`                                                          |
| P1   | 置き場所からのスコープ導出（ScopeEnvelope を mint）と `pipeline check`                               | `libs/core/pipeline/run-scope.ts`, `pipeline-readiness.ts`, `scripts/run_pipeline.ts`                                                                             |
| P2   | Effect Manifest のコンパイラ、承認カード v2、マニフェスト束縛 Charter と実行時の照合                 | `libs/core/pipeline/run-manifest.ts`, `project-trust.ts`, `accountability-charter*.ts`, `charter-scope.ts`, `external-operation*.ts`, `authorization-registry.ts` |
| P3   | `attended` / `unattended` の判定と Charter の `principal_modes`                                      | `libs/core/pipeline/run-principal.ts`                                                                                                                             |
| P2c  | ランナーへの組み込み（§3.4）、`--allow-unattended`、`pipeline check` の manifest 網羅率と v1/v2 判定 | `libs/core/pipeline/run-manifest-session.ts`, `scripts/pipeline/pipeline-execution-part-*.ts`, `scripts/cli.ts`, `pipeline-readiness.ts`                          |

P0〜P3 と P2c は実装済み。検証: `scripts/pipeline/pipeline-run-manifest-steps.test.ts`（全ネスト形の entry id と展開前 params のハッシュが compiler と一致）、`scripts/pipeline/pipeline-run-manifest.e2e.integration.test.ts`（headless Chromium と loopback ページで、v2 承認 1 回・個別承認 0 件で完走 / 1 バイト変更で `[TRUST_REQUIRED]`、v1 承認では最初の外部ステップで 1 回だけ承認要求 / manifest 外の goto は 1 回だけ承認要求 / attended のみの承認で unattended 実行は admit されない、`--allow-unattended` の承認なら完走）。

## 7. 変えないこと（不変条件）

- テナントを決める根拠は、置き場所とテナントレジストリである。クライアントや環境変数の値は絞り込みにしか使わない。
- 外部操作は1件ごとに、レビュー証跡・1回限りの commit・監査を残す。
- ファイルが変わったら、承認と Charter は自動的に無効になる。
- マニフェストに載らない操作（テンプレート化されたホスト、参照ステップ、上限のないループ、カードに出せない長いスクリプト、origin の決まらない secret、モデルが選ぶ経路）は、ステップごとの承認に戻る。
- 人が承認するのは、カードに出た文面そのものである。スクリプトは件数ではなく本文の抜粋とダイジェストで見せる。
- エージェントが動かすプロセスは attended にならない。attended は「承認した本人が端末にいる」ことであり、端末があること・誰かがメンバーであることではない。
- ランナーが展開した値は最終値であり、actuator が再展開しない。
- 決定論パイプラインに推論の stub を割り込ませない。モデルを必要とする判定（`reasoning` / `wisdom` / `voice` / `core:*` の判定系）は、引き続き資格情報を必須にする。

## 8. 残る論点

- `secret:get` の値をページに入力する経路は、持ち出しの経路にもなる。対策として、secret 参照ごとに入力してよい origin を**その secret を使うステップの直前の静的遷移先 1 つ**に束縛する（manifest の origin 全体ではない）。別の承認済みサイトにリダイレクトされた後の入力はステップごとの承認になる。テンプレート化されたセレクタやフレームに入るセレクタ（`>>`、`internal:control=enter-frame`、`frame=`、`frame*` 引数）へ secret を入力するステップは束縛しない。
- **決定（2026-11-25 セキュリティレビュー後）:** (1) エージェント駆動のプロセスは常に unattended。(2) attended は承認した owner（または deputy）だけ。(3) secret の origin は secret ごと。(4) スクリプトはカードで本文を見せ、出せない長さなら束縛しない。(5) `core:loop_until` はループとして上限を数え、`core:judge_route` より後のステップは束縛しない。(6) テナントのない常駐 Dot / chronos の親 envelope（mission なし）の下でテナント配下のパイプラインを動かすことは、テナントを足す「絞り込み」として許す。mission が親にあるときは mission 記録がアンカーするテナントしか足せない。
- **1 日あたりの run 回数の上限（実装済み）。** 承認するときに `--runs-per-day N` で決め（既定 20、1〜1000）、カードと v2 payload に束縛し、Charter の envelope の `runs_per_day` に載せる。`recordRunManifestRunStarted` が当日（UTC の暦日）の `run_started` を数え、上限に達した run は束縛しない（run は止めず、ステップごとの承認に戻る）。日の区切りを UTC にしたのは `money.per_day` と同じ区切りにそろえ、端末のタイムゾーンで結果が変わらないようにするため。上限の導入前の v2 承認は既定の 20 で数える。同じマニフェストの全ての Charter を合算して数えるので、承認し直しても当日の数は戻らない。外部操作ゲートは、その run が当日 Charter の台帳に記録されていることも確かめる（記録せずに束縛を張っても上限を飛ばせない）。 束縛は `run_started` の記録を、束縛を置いた UTC の日（と現在の日）で確かめる。そのため 23:59 に記録した run の最初の外部ステップが 0:01 でも事前承認は保たれる（記録と束縛が日付をまたぐ 60 秒以内のずれも許す）。
- **束縛時刻は呼び出し側から受け取らない（2026-11-26 硬化）。** 以前の `withRunManifestBinding` は試験用の `boundAt` を入力に持っていた。この関数はプロセス内に公開されているので、信頼された呼び出し側が古い日付を渡せば、前の日に記録した run id を「束縛した日の記録」として使い回し、当日の上限を数えずに通れた。今は束縛を置いた瞬間の時計だけを使う（入力に `boundAt` を付けても無視する）。0 時をまたぐ扱いは変えない（束縛した日・今日・束縛の 60 秒前までの `run_started` を認める）。試験は `vi.useFakeTimers({ toFake: ['Date'] })` で束縛時の時計を動かす。
- **plugin は組み込みの actuator op を上書きできない（2026-11-26 硬化）。** 以前は `registerPluginActuatorOperation` で登録した op が `resolveActuatorOperation` で組み込みより優先された。plugin が `browser:goto` を名乗れば、browser catalog の `actionInput`（options の絞り込み・run のセッション）も、manifest の前提も通らない実装に差し替わっていた。今は、組み込みの actuator ドメイン（op registry に宣言されているか actuator manifest がある）が registry で宣言している op（そのドメインの op と共有 op）と同じ名前の登録を、`[OP_REGISTRY_PLUGIN_CONFIG] <op> is a built-in actuator operation — a plugin cannot shadow it | next: …` で拒否する（廃止 op の再登録を拒否するのと同じ場所・同じ形）。組み込みドメインに新しい action を足すことと、plugin 自身のドメインで共有 op と同じ action 名を使うことは引き続きできる。
- **native 形式のレビュー後の硬化（2026-11-26）。** (1) `{{env.X}}` を資格情報として扱う（origin を 1 つに固定・セレクタの検査・カードの文言・URL に含めば束縛しない）。(2) `browser run --adf` が identity を切り替えるのは admit する束縛のときだけにし、そのぶん広がる書き込みはステップのファイルを run のパーティションに閉じる。(3) entry id は配列の位置で数える。(4) 形式の判定を承認・check・実行時でそろえ、`pnpm pipeline` は native ファイルを拒否する。(5) セッションの暗黙の永続プロファイルを、束縛された run ではパーティションに閉じてカードに出す。(6) 引数書き換え案は資格情報を args に移さず、型の注意を毎回添え、ファイル全体ではなくステップごとに出す。(7) 範囲外へファイルを書くステップは、実行中に止まるのではなく、承認前に `write_path_unconfined` として見え、実行時は `browser:write_file` でパスごとに人が決める。(8) `export_failure_bundle` を書き込み一覧に入れ、手順の解決器を通す。`import_session_handoff` の読み込み先を閉じる。シンボリックリンクは境界で拒否する。束縛中は CDP で再接続しない。(9) 束縛された `browser run --adf` も `surface_runtime` のまま dispatch し、ゲートの読み書きはその run のテナントと manifest に限ったゲートストアを通す（§3.5「ゲートの読み書き」）。束縛しても読み取りの範囲は広がらない。`import_session_handoff` の読み込み先は run 自身のパーティションに絞った。残り: (a) `surface_runtime` そのものは `active/shared/runtime/` 全体を読み書きできる（他のテナントのブラウザプロファイルも含む）。これは束縛されない run と同じで、束縛で広がるものではない。ステップの指定するファイルは上の閉じ込めで run のパーティションに限るが、actuator 内部の固定の置き場所（セッションのプロファイルや trace）はこの role の権限のままである。(b) `pause_for_operator` の `continue_file` は今も `active/shared/runtime/browser/` 全体の下を読む（存在を確かめるだけで、中身はブラウザに入らない）。(c) ゲートストアの `charter-read` は、常設の tripwire を確かめるため、そのテナントの `charters/` 直下の全ての Charter と台帳を読める（有効な Charter を探すために一覧する）。(d) ADF の `pnpm pipeline` は従来どおり呼び出し元の identity でブラウザのステップを動かす（ゲートストアは使わない）。
- `unattended` での利用は、承認カード上で明示的に有効にしたときだけ許す（`--allow-unattended`）。evaluate スクリプトを人の目なしで動かすことになるため。
- **再開（`--resume` / ライブラリ継続）は束縛しない。** 実行回数（occurrence）は束縛ごとのメモリ上でしか数えないため、journal から数え直さない限り上限を正しく守れない。最も単純で正しい選択として、再開した run は manifest に束縛せず、全ての外部ステップをステップごとの承認に戻す（`openRunManifestSession` の `resumed`）。journal の `node_completed` から entry ごとの回数を復元する方式は、葉ステップの entry id を journal に記録してから検討する。
- **ネストした run は親の束縛を引き継がない。** `core:run_pipeline` の子は `withoutRunManifestBinding` の下で、かつ自分の束縛も開かずに（`manifestBinding: false`）実行する。親の manifest は子を `incomplete` として扱う。
- **ループの各回は別の occurrence。** `core:while` / `retry_until_quality` の各回を `withExternalOperationOccurrence` で区切る（`core:foreach` の各要素と同じ）。区切らないと、同じ外部操作の 2 回目が 1 回目の 1 回限り予約と衝突して `[EXTERNAL_EXECUTION_ALREADY_RESERVED]` で止まっていた（承認フローのシナリオの evaluate ポーリングが該当）。
- **evaluate の `args`。** パイプライン JSON の `script` は文字列なので、`args` を付けたときは関数型の page function として Playwright に渡す（`pageFunctionSource`）。文字列のままだと式として評価され、関数そのものが返って `undefined` になっていた。
- **ブラウザの `session_id` と `options`（2026-11-26 修正）。** ランナーは browser op を 1 ステップずつ SDK 経由（catalog の `actionInput`）で呼ぶ。以前の `actionInput` はパイプラインの `session_id` と `options` を渡しておらず、全ステップが匿名の `default` セッション・既定値で動いていた（headful もプロファイルの再利用もできず、loopback / 社内ホストへは行けなかった）。今は各ステップに渡す。同じ run の各ステップは同じセッションを使い、`keep_alive` で保持される。オンボーディングの隔離遷移（`onboarding_isolated_navigation`）だけは従来どおり使い捨てのセッションで動き、どちらも受け取らない。
  - **値はパイプラインファイルからしか取らない。** ランナーはファイルの `session_id` / `options` を凍結したコピーとして AsyncLocalStorage に載せ（`withPipelineRunSession`、`libs/core/actuator/actuator-sdk.ts`）、browser の `actionInput` と SDK の既定 envelope はそこから読む。ステップは任意の context キーへ export できるため、ページが返した値が `__pipeline_options` を書き換えても後続のステップには効かない。context 側の `__pipeline_options` / `__pipeline_session_id` も、`--context` やライブラリ呼び出しの `context`、再開時に復元した値をファイルの値で上書き（ファイルに `session_id` が無ければ削除）する（`pinPipelineSessionContext`）。ファイルの内容は content hash で承認に束縛されている。
  - **適用するのは許可した項目だけ。** 判定は 1 つの分類器（`classifyPipelineBrowserOptions`、`libs/core/pipeline/pipeline-browser-options.ts`）で行い、browser actuator・manifest・`pipeline check` が同じ結果を使う。`headless`・`viewport`・`locale`・`timeout_ms`・`max_steps`・`keep_alive`・`lease_ms`・`action_trail_max`・`navigation_policy`（深いコピー）・`browser_channel`（chromium / chrome）・`profile_directory`（フォルダ名のみ）は適用する。閉じたブラウザから出る設定（`connect_over_cdp`・`cdp_url`・`cdp_port`・`launch_args`・`profile` / `profile_name` / `profile_email`・`record_trace`・`browser_runtime`・`runtime_purpose`）は適用しない。ディスクに書く 2 つは run のパーティションの中でだけ適用する: `user_data_dir` は `active/shared/runtime/browser/profiles/<tier>/<tenant|shared>/<名前>`、`record_video` の `video_artifact_dir` は artifact フロア `active/shared/artifacts/<tier>/<tenant|shared>/browser-video/<名前>`。tier と tenant は**ファイルの置き場所から導出した RunScope** で決める（テナントのないファイルは `<tier>/shared`）。`KYBERION_TENANT` や親の envelope では決めない。
  - **適用しない項目は失敗させず、落として警告する。** ランナーが options を渡す前は全ての項目が黙って無視されていたため、それで動いていたシナリオ（`record_video: false`・`record_trace: false`、パーティション外の `user_data_dir` など）を止めないためである。`false` や未設定は何もしない。それ以外の落とした項目は run ごとに 1 回 `what — why | next` で警告し（置くべきパスを示す）、`pnpm pipeline check` は `browser` 行に warning として出す。
  - run-manifest の束縛がある間は、context の `__pipeline_options` / `__pipeline_session_id` には戻らない（ランナーが載せた値か、何も使わない）。`keep_alive` / `lease_ms` の外側の値も context ではなくランナーが載せた値から読む。plugin が登録した `browser:*` op と scenario の fixture は `actionInput` を通らない（前者は provenance で承認された別の実装で、組み込みの op 名は名乗れない。後者は実ブラウザに届かない）。
  - **承認カード。** manifest は、実際に適用する値だけを持つ: 柵を緩めるとき `requirements.browser_navigation: { allow_private_network: true }`、永続プロファイルを使うとき `requirements.browser_profile: { user_data_dir }`、録画するとき `requirements.browser_recording: { video_artifact_dir }`。カードにそれぞれ 1 行を出す（`Browser: allows private-network navigation …` / `Browser: uses the persistent profile … (keeps its logins between runs)` / `Browser: records the session on video to …`）。落とす値はカードに出さず、manifest とハッシュも変えない。パーティション内のプロファイルや録画を設定したパイプラインはハッシュが変わるので、承認し直しが要る。
  - E2E テストは回避策をやめ、本番と同じ SDK ディスパッチ（`actuator.dispatch`）で headless Chromium を loopback ページへ向ける。テナントのプロファイルパーティションを使うこと、ステップが `__pipeline_options` / `__pipeline_session_id` へ export しても後続の遷移が承認どおりに動くこと、呼び出し側の `context` で柵を外そうとしても `[BROWSER_NAVIGATION_BLOCKED]` で止まることを確かめる。
