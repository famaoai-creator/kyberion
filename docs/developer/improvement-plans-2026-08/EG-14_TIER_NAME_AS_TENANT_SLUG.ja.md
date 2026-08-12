# EG-14: ティア名がテナントスラッグとして使われている

> **記録日**: 2026-08-12
> **発見元**: ミッション `MSN-ORG-FOUNDATION-20260812` のテナント registry 棚卸し
> **位置づけ**: [ENTITY_GOVERNANCE_UNIFICATION_PLAN](./ENTITY_GOVERNANCE_UNIFICATION_PLAN_2026-08-09.ja.md) の追補。EG-11(一回性クリーンアップ)では解けない**再発する**ドリフトのため別項目とする。
> **優先度**: P2（実害は限定的だが、境界モデルの基本前提に反する）

## 症状

`check:tenant-registry` が `customer/public/` を「テナントプロファイルの無いテナント」として drift 報告する。ディレクトリを消しても**次のテスト実行で再生成される**。

## 原因

`libs/core/mission-work-reconciliation.test.ts:121,151` が `tenant_slug: 'public'` で work item を作る。
`audit-chain.ts:417` は「slug があればテナント別に `customer/{slug}/logs/audit/` へミラーする」ため、監査ミラーが `customer/public/` を生やす。

同型で `tenant-meeting-ops`（`libs/actuators/wisdom-actuator/src/meeting-ops.test.ts:32`）もあるが、そちらは単なる fixture スラッグであり命名としては不正でない。

## なぜ問題か

`public` は**ティア名**であって、テナントではない。
[entity-scope-hierarchy](../../../knowledge/product/architecture/entity-scope-hierarchy.md) は明示している:

> `shared` is an explicit public/shared storage partition. It is not a tenant
> and must not satisfy the required `tenant_slug` field for confidential data.

`shared` について書かれた規則だが、同じ理由が `public` にも当てはまる。ティアとテナントは直交する軸であり、片方の値がもう片方を満たしてはならない。テストがこの前提を破っていると:

- ティア名がテナント名前空間に混入し、`customer/public/` のような**意味の壊れたディレクトリ**が生える
- 将来 `tenant_slug` の妥当性検証を厳格化するとき、テストが先に落ちる
- 「テナント registry のドリフトは実データの問題」という読みが崩れ、ドリフト報告全体の信頼性が下がる

## 暫定対処（2026-08-12 実施済み）

`tenant-registry-exceptions.json` に `public` / `tenant-meeting-ops` を、**書き込み元のファイル名まで含めて**例外宣言した。ドリフト報告は静かになるが、原因は残っている。

## 本対処（未実施）

1. `mission-work-reconciliation.test.ts` の `tenant_slug: 'public'` を、テスト専用の正当なスラッグ（例 `__reconciliation_test`）に置き換える。既存のテストシンク命名（`__pptx_sink_persist_test` 等）に倣う
2. 置換後、`tenant-registry-exceptions.json` から `public` の例外を削除する
3. 併せて、`tenant_slug` にティア名（`public` / `confidential` / `personal` / `shared`）を受け付けない検証を `assertTenantSlug` に追加することを検討する。これを入れれば同種の混入は二度と通らない

## 実施した対処（2026-08-12）

1. **`entity-scope.ts` に `RESERVED_SCOPE_NAMES` / `isReservedScopeName()` を追加。** ティア名と `shared` はテナントを名乗れない、という規則を実行可能な宣言として置いた。階層の正本と同じモジュールに置いたのは、これが階層規則そのものだから。
2. **監査ミラーが stance オーバーレイを生成しないようにした**（`audit-chain.ts`）。`customer/{slug}/` が既に在るときだけミラーする。無ければ黙って skip する — master チェーンには記録が残るので情報は失われず、`verifyTenantMirrors()` はミラーの無い slug をもともと skip するので整合も崩れない。
3. **`resolveCurrentTenantSlug()` と `assertTenantSlug()` が予約語を拒否**するようにした。前者は `KYBERION_TENANT=public` が全監査レコードを汚すのを止め、後者はティア名のテナントプロファイル（＝知識ルートとストレージ区画）が作られるのを止める。
4. **テスト側**: `tenant_slug: 'public'` を `'shared'` に変更した。

### 4 について（判断の記録）

当初 `'public'` `'shared'` の両方をテスト専用スラッグ（`test-analysis-intent` 等）に置換したが、**これは誤りだった**。`shared` は checker が「テナントではなくパーティション」として認識する正当な値であり、`active/projects/public/shared/` という既存のレイアウト規約とも一致する。テスト専用スラッグに置き換えた結果、checker が「project registry に居るがテナントプロファイルが無い」と新たな drift を報告した。

**誤りだったのは `public`（ティア名）だけで、`shared`（パーティション名）ではない。** `assertTenantSlug` は両方を拒否するが、これはテナント*プロファイル*の作成に対する制約であり、project レコードの `tenant_slug` は通らないので規約と衝突しない。

## 第 2 の再発源: テスト実行がプロジェクトワークスペースを残す（2026-08-12 対処済み）

`vitest run libs` のたびに `active/projects/**` に未登録ワークスペースが生成され、`check:entity-governance` が drift として報告していた。**EG-11 のクリーンアップで消しても次のテスト実行で戻る**性質のもの。

調べたところ、**root 注入の seam は不要だった**。原因は 2 つに分かれ、どちらも狭い修正で閉じた。

### 原因 1: teardown がミッションだけ消してプロジェクトを残す（テスト側）

対象テストは `KYBERION_TEST_OBSERVABILITY_DIR` 等の hermetic seam を既に多数持ち、`afterEach` でミッションディレクトリも消していた。しかし fixture の `mission-state.json` が `project_path` を宣言しているため、dispatch が**ミッションの隣にプロジェクトワークスペースを実体化**する。teardown はそれを消していなかった。

`afterEach` にプロジェクトワークスペースの削除を追加:

- `libs/core/mission-orchestration-worker.test.ts`（`MSN-FOLLOWUP`）
- `libs/core/mission-orchestration-worker.kp05-trace.test.ts`（`MSN-KP05-TRACE-${pid}`）
- `libs/core/mission-orchestration-worker.ni03-delegation.test.ts`（`MSN-NI03-CHAIN-${pid}`）

観測ストリームを「vitest 下では書かない」と gate している `observability-gate.ts` が「ミッション配下は gate しない — suite が意図的に fixture を作るため」と明記しているとおり、**ここは gate ではなく後片付けで閉じるのが設計意図**に沿う。

### 原因 2: プロジェクト状態が tenant 区画の外に書かれる（実装バグ）

`PRJ-PMC-TEST-BOOT` だけはテスト側を直しても残った。`active/projects/confidential/shared/PRJ-PMC-TEST-BOOT/state/project-state.json` が生成され続けたためで、これは**テスト残骸ではなく実装バグ**だった。

`bootstrapManagedProject`（`libs/core/project-management.ts`）が `saveProjectOperationalState` を呼ぶ際、`tier` は渡すが **`tenant_slug` を渡していなかった**。状態ファイルの置き場は tier と tenant の両方で区画されるため、slug が無いと `shared` にフォールバックする。結果:

- **confidential なプロジェクトの状態が `shared` 区画に書かれる** — テナント境界の外
- テナントスコープの問い合わせから**見えなくなる**（`listProjectOperationalStates({tenantSlug})` は `tenant_slug || 'shared'` で突合するため）

同ファイルの reconcile 側（`nextState`）は `tenant_slug: scope.tenant` を正しく渡しており、bootstrap 経路だけが欠けていた。`nextProject.tenant_slug` を渡すよう修正。

これは EG-14 の本題（ティア名/区画名がテナントを名乗る）と**表裏**の問題である。前者は「区画名がテナントの座に入る」、後者は「テナントが区画名の場所に落ちる」。どちらも tier と tenant を直交した軸として扱えていないことから来ている。

### 原因 3: レジストリレコードを作りっぱなしにする（テスト側）

原因 1 を直した直後、drift の形が **「未登録ワークスペース」から「登録済みだがワークスペースが無い」に反転**した。ワークスペースは消えるようになったが、テストが `saveProjectRecord()` で書いた**レジストリレコード**が残るため。

- `libs/core/analysis-intent-support.test.ts` — `PRJ-REVIEW` / `PRJ-BIND`
- `libs/actuators/media-actuator/src/index.test.ts` — `PRJ-MEDIA-BRAND` / `PRJ-DESIGN-REF`

`projectRecordPath()` で消す `afterEach` を追加した。

この反転は、**片側だけ直すと drift の見え方が変わるだけで残り続ける**ことを示している。ワークスペースとレジストリレコードは対で生まれるので、対で消す必要がある。

### 検証

修正後、対象テスト群および `vitest run libs scripts` 全体を流し、`active/projects/**`・`active/missions/**`・`active/shared/runtime/projects/`（レジストリ）のいずれにも増加がゼロであることを確認した。

## 補足

3 を入れる場合は既存データへの影響を先に調べること。本記録の時点で `public` をスラッグとして持つ監査レコードが `customer/public/logs/audit/` に 31 行存在する（すべてテスト由来）。
