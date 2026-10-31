---
title: 'listen の confidential scratch — backend 読み取り権限の橋渡し設計ノート (R04 residual)'
tags: [perception, listen, stt, tier-guard, role-assumption, design-note, r04]
last_updated: 2026-10-31
---

# listen の confidential scratch — backend 読み取り権限の橋渡し (R04 residual)

状態: **実装済み (承認済み選択肢 (i))。** `transcribeWav` の backend loop を
`withExecutionContextAsync('perception_media_worker', fn, 'worker', tenant)` で包み、
`authority-roles/perception_media_worker.json` + security-policy.json の
tmp/staging `{confidential,personal}/${KYBERION_TENANT}/` grant +
`shared_core_roles` 登録 + TENANT_BOUND_READER_ROLES 登録で、interactive CLI が
自 scope partition の scratch を読める。R04 で landed した
permission_denied 分類は正しい fail-closed であり、本書で扱ったのは成功系の残課題。

以下は実装時点の設計記録として残す (原文の選択肢と承認パッケージは変えない)。

## 1. 確認済みのメカニズム

### 1.1 中間ファイルは誰がどこへ書くか

1. `kyberion listen` → `runListenCommand` (`scripts/cli-listen.ts:187`) →
   `createPerceptionWorkDir('listen', absolute)` (`scripts/lib/perception.ts:236-246`)。
2. `resolvePerceptionScope(sourceFile)` (`libs/core/perception/observation.ts:47-60`) は
   **active scope と入力推定 tier の高い方**を採る。永続 scope.env
   (`active/shared/runtime/scope.env`, tier=confidential / tenant=famao-ai —
   `scope-context.ts:76-115`) があると `active.tier=confidential` が勝ち、
   legacy tmp partition に置いた public 入力でも **scratch は confidential**。
3. `resolveStorageFloor('scratch', {kind:'tier', tier:'confidential', tenant:'famao-ai'},
'perception', 'listen-<uuid>')` (`storage-layout.ts:117-127`) →
   `active/shared/tmp/confidential/famao-ai/perception/listen-<uuid>/`。
   `safeMkdir` は `validateWritePermission` 経由 — **`default_allow` に
   `active/shared/tmp/` があり、write/mkdir は tier 判定より先に許可される**
   (`tier-guard.ts:1243-1248`)。
4. 16kHz mono wav は `extractSttWav` → `deps.runMedia` →
   `getPlatformDriver().runMediaCommand` → `safeExec` (`platform.ts:167-173`) —
   **ffmpeg は外部バイナリであり、子プロセス内に tier-guard は存在しない**。
   中間 wav は OS レベルで confidential partition に書き込まれる
   (Kyberion 側の guard が効くのは exec policy と allowlist env だけ)。

### 1.2 「backend subprocess」は実際には同一プロセス内の adapter

観測された `lstat` の `ROLE_VIOLATION` は外部バイナリ (whisperkit-cli) ではなく、
**bridge adapter の TS 側 guard** が発している:

- whisperkit-cli adapter: `transcribe` → `resolveAudioPath` (`assertSafeRepositoryPath`)
  → `safeExistsSync` (resource scope が無ければ metadata チェックを素通り) →
  `assertRegularFile` → **`safeLstat`** (`speech-to-text-bridge.ts:838-843`)。
- `safeLstat` → `guardReadPath` → `validateReadPermission(resolved, 'metadata')`
  (`secure-io.ts:1594-1605`, `secure-io-path-guard.ts:1000-1012`) →
  `inspectReadPermission` (`tier-guard.ts:1347-1517`)。
- `active/shared/tmp/confidential/` は `tenant_scope.protected_prefixes` に登録済みで
  `storageFloorTier` = `confidential` → `protectedFloorPath` → `checkTenantScope`
  (同一 tenant famao-ai で通過; `require_tenant_binding=false` のため tenant 未bind
  でもここは通る) → `personaTierReadDecision` (`tier-guard.ts:1642-1735`)。
- SUDO なし・authority grant なし・role rule なし・persona rule なし →
  `floorTier === 'confidential'` で deny → `safeLstat` が
  `[ROLE_VIOLATION] Role is NOT authorized to lstat path '…'` を投げる
  (`secure-io.ts:1598`)。
- Shell bridge (`KYBERION_STT_COMMAND`) は `local_only` 未宣言のため登録時 wrapper が
  `safeReadFile` で音声 hash を採る (`speech-to-text-bridge.ts:165-173`) —
  こちらはさらに早い段階で同じ読み取り拒否に当たる。

### 1.3 拒否側の identity は何か

永続 scope.env は **tier/tenant だけ**を運び、persona/role は運ばない:

- persona: `scopedPersona()` → `KYBERION_PERSONA` — 未設定なら
  `normalizePersona` で `'unknown'` (`authority.ts:262-275`, `1112-1197`)。
- role: `resolveRole()` — assumed role も `SYSTEM_ROLE`/`MISSION_ROLE` も無ければ
  `argv[1]` basename のヒューリスティック (`authority.ts:317-331`) に落ち、
  `kyberion_cli_entry` 等の role 名は `authority_role_permissions` に項目がなく grant ゼロ。
- `MISSION_ROLE` を worker 系 (例: `software_developer` = `active/projects/`,
  `tests/`, `libs/actuators/` のみ) から継承していても同じく floor grant なし → deny。

**書けて読めない非対称の理由**: write は `default_allow` が先に効く
(`tier-guard.ts:1243-1248`) が、read 側には `default_allow` 相当が存在しない。
同じプロセスが `safeMkdir`/`safeWriteFile` には成功し、`safeLstat` では
`ROLE_VIOLATION` になる — Round 2 で実測された挙動と一致。

### 1.4 誰なら読めるか

`active/shared/tmp/confidential/${KYBERION_TENANT}/` を読める grant:

- **persona `worker`**: `persona_permissions.worker.allow_read` に tenant 展開
  対応の当該 prefix が明示登録されている。
- **広い tmp grant を持つ role**: `infrastructure_sentinel` / `asset_promoter` /
  `secret_introduce` / `dot_lifecycle_writer` / `pr_publication_store` /
  finance・sales・marketing・talent・line_manager 系 (`active/shared/tmp/`)。
- **capability-bound な reader**: `memory_provenance_reader` は当該 prefix の
  allow_read を持つが、`requestResourceDenial` が role 名で capability を強制
  (`tier-guard.ts:1027-1034`, `[MEMORY_PROVENANCE_READ_SCOPE]`) するため流用不可 —
  dedicated role は exact capability に縛られる先例。
- **claimed WorkItem の子実行**: `task_runtime_worker` の `default_persona` は
  `worker` (`authority.ts:83` `LEGACY_ROLE_PERSONA_DEFAULTS`) — 正規 dispatch 下の
  子プロセスは worker persona に推定され、**当該 scratch を既に読める**。
  つまり `perceptionErrorNext` が指す「claimed WorkItem 経由」は現行コードで
  成立する正常系であり、欠けているのは **interactive CLI (bare `pnpm kyberion
listen`) の identity** だけ。
- `buildSafeExecEnv` は `MISSION_ROLE`/`KYBERION_PERSONA` と assumed scope の
  role/persona を子へ引き継ぐ (`secure-io.ts:77-139, 244-252`) — Kyberion-aware
  な子にも同じ identity が伝播する設計は既に存在する。

## 2. 最小の governed 選択肢 (順位付き)

### (i) 既存の governed role assumption で backend 呼び出しを包む — 推奨

`transcribeWav` の backend loop (および scratch を読む `assertAudioAnalysisDuration` /
bridge 内 guard) を `withExecutionContextAsync(<role>, fn, 'worker', tenantSlug)`
で包む (`authority.ts:994-1004`)。

- **既にあるもの**: RA-01 の in-process assumption 機構、tenant bound scope による
  `${KYBERION_TENANT}` 展開 (`authority.ts:1124-1128`)、`buildSafeExecEnv` への
  role 伝播、先例 (`authority.ts:1359-1366` の
  `withExecutionContext('workspace_tenant_registry_reader', fn, 'worker', tenant)`)、
  worker persona の当該 prefix grant。
- **足りないもの**: 専用の perception reader/worker role が catalog に存在しない。
  既存 role の借用は capability-bound (`memory_provenance_reader`) か広い grant の
  role-fit 違反 (`infrastructure_sentinel` 等) で不適。新 role
  (仮 `perception_media_worker`) の宣言が必要:
  `authority-roles/perception_media_worker.json` (`default_persona: worker`) +
  `security-policy.json authority_role_permissions` に
  `active/shared/tmp/confidential/${KYBERION_TENANT}/` と
  `active/shared/staging/confidential/${KYBERION_TENANT}/` (必要なら personal 同型) の
  allow_read/allow_write + `role-assumption-policy.json shared_core_roles` への登録 +
  `role-assumption-reachability` gate の通過
  (`scripts/analyze_role_assumptions.ts` がメモリ上で到達可能 role を計算し、未許可なら失敗)。
  可能なら dedicated store role と同じ `currentResourceAccessScope` exact
  capability 縛りにすると grant の濫用面が最小。
- **触る境界**: security-policy.json / role-assumption-policy.json / authority-roles/
  — security boundary 変更であり**人間承認が必須** (計画 §3.1)。
  SYSTEM_ROLE 配下の surface では may_assume リストへの追加も別途必要。
- **付帯確認**: この経路は caller の scope を昇格するのではなく、「perception
  backend という既知の仕事を、scope が所有する tier の scratch に対してだけ、
  宣言済みの役割で実行する」claim の形式化 — 権限は同等以下の委譲。

### (ii) filesystem パスではなく authorized bridge / streaming read 経由にする

- **既にあるもの**: dedicated store role の `currentResourceAccessScope`
  exact-capability パターン (`RESOURCE_SCOPE_REQUIRED` 系) は、「この role は
  この exact path の read-only 能力だけを持つ」mediated read の設計先例。
  `TranscribeInput` は現状 `audioPath` 前提 (`speech-to-text-bridge.ts:59-65`)。
- **足りないもの**: perception scratch 向け capability が存在しない。
  `TranscribeInput` に bytes/stream 系を足す API 変更 + capability minting +
  resource scope の plumbing が必要。加えて **native 子バイナリの OS 読み取りは
  そもそも tier-guard を通らない**ため、stream 化が助けるのは Kyberion-aware
  consumer のみ — native backend 向けには結局 granted context での読み取り
  (=(i)) が必要で、単独では問題を解かない。
- **触る境界**: (i) と同じ policy 承認 + bridge contract の API 変更。
  (i) より重いため下位。

### (iii) backend 側 role が読める governed scratch floor を用意する

- 「caller の実 identity が読める floor に置く」は、persona `unknown` / 無名 CLI
  role が confidential floor を読める状況を作ること = **tier 降格であり計画
  §3.1 で禁止**。`confidential/shared` セグメントも救わない
  (tenant undefined partition も `protectedFloorPath` で unknown persona は拒否;
  tenant 分離も弱める)。
- 正直な形 (その role に対象 floor の grant を宣言する) は (i) と等価 — 単独の
  選択肢にはならない。降格版は実施不可としてここに記録する。

## 3. 推奨と承認依頼

**推奨: (i)** — `withExecutionContextAsync` + 新設の狭い
`perception_media_worker` (仮) role で、bridge 呼び出しだけを tenant-bound な
worker persona 相当の context で実行する。scope 降格も operator 回避も不要で、
claimed-WorkItem 正常系と同じ effective identity を interactive CLI に与える。

必要な承認 (1 パッケージで人間レビューへ):

1. `security-policy.json` — `authority_role_permissions.perception_media_worker`:
   `active/shared/tmp/confidential/${KYBERION_TENANT}/` および
   `active/shared/staging/confidential/${KYBERION_TENANT}/` の allow_read/allow_write
   (personal tier が listen 対象なら同型を追加; deny 規定は不要のはずだが
   reviewer が確認)。
2. `knowledge/product/governance/authority-roles/perception_media_worker.json` —
   role 宣言 (`default_persona: worker`)。
3. `role-assumption-policy.json` — `shared_core_roles` への追加と rationale;
   SYSTEM_ROLE surface から呼ぶ場合は当該 `may_assume` にも追加。
4. `pnpm check -- --only role-assumption-reachability` で到達可能 role が
   すべて許可されていることを確認 (レポートはコミットしない)。
5. 実装側: `transcribeWav` (必要に応じ `extractSttWav` 出力の後続検証 read も)
   を `withExecutionContextAsync` で包み、tenant は `resolvePerceptionScope`
   の返り値から受け取る。`runExternalOperation` の approval / egress 判定は
   変更しない。

**それまでの正しい状態**: `permission_denied` 分類 + WorkItem dispatch 導線の案内
(= R04 landed)。`perceptionErrorNext` の「operator shell」表現は不正確 —
bare shell では persona が `unknown` のままで依然拒否される。
現行コードで直ちに成功させたい場合の正式な道筋は、worker persona に解決される
claimed WorkItem 経由 (または operator が `KYBERION_PERSONA=worker` を明示宣言 —
env 宣言は governed claim ではないことに注意) であり、本 residual は
「interactive CLI に governed な実行 context を与えるか」の設計判断として保留する。
