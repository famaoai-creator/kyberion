---
title: 'Build-Generation Receipt v1 — 設計レビュー (R12)'
tags: [build, reliability, design-review, r12, receipt]
last_updated: 2026-10-31
---

# Build-Generation Receipt v1 設計レビュー (R12)

- 対象: `libs/core/build-generation.ts` (schema v1)、発行側 `scripts/build_repository.ts` (commit `1134d1af4`)、読み側 `scripts/baseline_build_readiness.ts` / `libs/core/build-readiness.ts`
- 基準: worktree `agent-cli-reliability`、base `bfefd82b5`、計画 `kyberion-reliability-plan.md` §3.3 / R12
- 結論: **approve-with-conditions** (後述の条件 C1–C4。設計上の差し戻し事由はない)

## 1. §3.3 要求と schema v1 の対応表

| 計画 §3.3 / R12 の要求      | schema v1 の欄                                                                                                                                  | 評価                                                                   |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| schemaVersion               | `schemaVersion: 1` (literal type)                                                                                                               | ✅ parseReceipt が literal 一致で validate                             |
| generation ID               | `generationId` (build attempt の randomUUID)                                                                                                    | ✅ PFC record の `id` と同一値を共有 (provenance test が固定)          |
| source fingerprint          | `inputFingerprint` = `fingerprintBuildInputs()` — path+content sha256、owned target 全 compiler 入力、tracked/untracked 不問                    | ✅ §3.3-1/§3.3-2 を満たす                                              |
| config/lockfile fingerprint | `configFingerprint` = `fingerprintBuildConfigInputs()` — `BUILD_CONFIG_INPUTS` (package.json, pnpm-lock.yaml, tsconfig 群, package 各 tsconfig) | ✅ lockfile は config 側に内包                                         |
| tool versions               | `toolVersions { node, typescript?, pnpm? }` — node は `process.version`、tsc は node_modules manifest、pnpm は `npm_config_user_agent`          | ✅ 取れない値は undefined のまま (推測しない)。env dump / token 非含有 |
| build mode                  | `mode: 'all' \| 'packages' \| 'repo'`                                                                                                           | ✅                                                                     |
| 開始/終了                   | `startedAt` / `finishedAt` (ISO)                                                                                                                | ✅                                                                     |
| result                      | `result: 'completed'` (literal)                                                                                                                 | ✅ 完了世代のみ。failed/aborted は receipt 自体を発行しない設計        |
| 入力安定性                  | `inputStability: 'stable_observed'` (literal)                                                                                                   | ✅ 正直な命名 — 後述 §3                                                |
| 秘密値を含めない            | fields は id/時刻/hash/version のみ                                                                                                             | ✅                                                                     |

計画の「receipt は証跡であり権威ではない」原則: `BuildGenerationIdentity` は provenance ラベル (`receipt`/`legacy_receipt`/`stamp`/`none`) であり、`judgeBuildReadiness` の fresh 判定は常に scan の結果のみに依存する。receipt 不在や破損が green を生む経路は存在しない (build-readiness.ts:53–72, 112–204)。

## 2. dist/ への同居 (colocation) の評価

保存先 `dist/.build-generation.json`:

- **利点**: receipt が記述する成果物と寿命が一致する。`pnpm build` 先頭の clean ステージ (`scripts/clean.ts`)、dist の差し替え、別 worktree での再生成で receipt も消えるため、「dist だけが消えて receipt が残り続ける」 orphan 証跡にならない。`dist/.session-build-head` (agent-worktree 所有) と同じ floor・同じ寿命で、既存慣行に一致する。
- **制約**: `dist/` は gitignore されるため receipt は repo 外証跡であり、CI artifact への採取 (pr-validation.yml の `build_generation` 行) は既に別経路で担保されている。
- **代替案との比較**: `active/shared/runtime/` 配下に置く案は receipt が dist より長生きし、dist 差し替え後に旧世代の証跡を誤って名乗る余地がある。dist 同居は「receipt は dist の属性」のモデルとして正しい選択。

**留意**: dist ツリーごと外部から復元された場合、receipt も一緒に戻る → provenance は `receipt` を名乗るが `inputFingerprint` が現入力と乖離する。receipt は権威でないため readiness scan がこれを検出する (fail-safe)。reviewer は「receipt が fresh を主張しない」ことを確認すればよく、colocation 由来の残課題はこの点のみ。

## 3. `stable_observed` の正直さと限界

- 実装は build 前後 (compiler-outputs lock 内) で入力 fingerprint を 2 回採り、一致時のみ `stable_observed` を publish する (build_repository.ts:307–325)。
- **A→B→A は証明不能**: 前後 hash が一致しても、ビルド中に source が変更→復元されていた可能性は排除できない。型が `stable_observed` と名付けられ、`isolation`/`stable` を名乗らないのは計画 §3.3-4 / R12-2 の要求どおり正直である。
- `changed_observed` → receipt 不発行 + `restored=false` + reason。`unverifiable` (snapshot 失敗) → receipt 不発行のみ、build 結果は untouched。どちらも last good receipt を上書きしない。
- **残る限界 (条件 C3)**: fingerprint の snapshot 自体は原子的でない — スキャン中に source が動くと「混ざった fingerprint」ができる。後 fingerprint が混ざっていて前と一致した場合のみ誤 stable だが、混ざると値が変わる方向に働くため fail 方向は安全側。compiler-outputs lock は dist 書込みを守るものであり source 書込みは止めない (build-coordination.ts は lock-utils のファイルロックによるプロセス間 mutex) — この非対称はコードコメントと本レビューで明記済み。
- **`hashFile` の `<unreadable>` プレースホルダ**: 前後とも読めない file は同一 fingerprint になり「stable」扱いになる。unreadable→readable は hash が変わり検出される。fail-safe 方向で許容だが、文書化する (条件 C3)。

## 4. 原子性と並行性

- publish は `safeWriteFile` (secure-io.ts:494–630) — bounded temporary sibling への 'wx' 作成 → `fs.linkSync`/`renameSync` による atomic publish。reader が torn receipt を見ることはない。
- 発行は `deps.lock` = `withCompilerOutputs` (inter-process file lock、stale reclaim 付き) の内側で行われる。inspector (`tryInspectCompilerOutputs`) と同じ mutex を共有するため、publish の途中で doctor/baseline が観測することはない。
- publish 失敗は catch して warn のみ — build 成功を receipt 書き込み失敗で壊さない (receipt は additive evidence)。
- 2 builder 同時実行: 先に lock を取った方が直列化される。後発の build は「入力が前後で動いた」か「receipt が新世代に更新される」のどちらかになり、混在 receipt を書く経路はない。

## 5. legacy / invalid receipt の扱い

`readBuildGenerationReceipt` の4値:

| status    | 条件                                                | 影響                                                             |
| --------- | --------------------------------------------------- | ---------------------------------------------------------------- |
| `none`    | ファイル不在                                        | provenance `none` または `.session-build-head` stamp へ fallback |
| `valid`   | schemaVersion=1 かつ全 required field               | provenance `receipt`                                             |
| `legacy`  | 有効な JSON だが schemaVersion ≠ 1 (将来の v2 含む) | `legacy_receipt` — green にならない                              |
| `invalid` | 読み取り失敗 / 非 JSON / required field 欠落        | `legacy_receipt` + detail — green にならない                     |

旧形式との互換は「reader が legacy/invalid を検証なし green としない」形で保持 (R12 rollback 要件どおり)。`.session-build-head` は読み取り専用の旧来 evidence として残り、所有は agent-worktree のまま (build-generation.ts:31–34)。

## 6. 残存リスク

1. 部分 mode ('packages') でも fingerprint は `defaultStaleDistTargets()` の全 owned target を対象とする → 対象外 source の変更でも receipt が出ない (偽陰性方向 = 安全側だが、receipt 不在が多発すると provenance が `none`/`stamp` に戻り診断価値が薄れる)。v2 で per-mode input set を検討する余地。
2. `finishedAt` は readiness 判定後・publish 直前の時刻であり、compile 終了時刻ではない (数秒以内の近似)。監査目的には十分。
3. config fingerprint に npm_config_user_agent 由来の pnpm version は含まれない (toolVersions 側に記録)。ツールchain の drift は toolVersions で別途確認可能。
4. receipt そのものは署名なし — 悪意ある actor が dist ごと差し替えれば receipt も作り直せる。脅威モデル上 receipt は運用証跡であり改ざん防止対象ではない (build evidence は secure-io floor にある) が、監査用途に使うなら別途 ledger 側の build record と照合する。

## 7. マージ時に reviewer が検証すること (条件)

- **C1 (merge gate)**: `pnpm exec vitest run libs/core/build-generation.test.ts scripts/build_repository.provenance.test.ts scripts/check_stale_dist.test.ts libs/core/environment-capability-probes.test.ts scripts/run_doctor.probes.test.ts` が全 pass + `pnpm run ci` 相当 (validate+test) が worktree で完走すること。本レビュー時点では full `pnpm run ci` 未実行 (residual)。
- **C2 (no green-path 確認)**: 「receipt が存在する」だけで fresh と判定する consumer がないことを、将来の consumer 追加時も維持する。`BuildGenerationIdentity` は provenance ラベル専用とする。
- **C3 (文書化)**: §3 の残る限界 (snapshot 非原子性・`<unreadable>` 同値・A→B→A 不可証明) を build-generation.ts のヘッダコメントまたは本ドキュメントへの参照として残す。
- **C4 (schema 進化)**: v2 で field を追加する場合は `BUILD_RECEIPT_SCHEMA_VERSION` を上げ、v1 reader が v2 receipt を `legacy` として fail-closed に扱う現行挙動を contract test で固定する。

## 8. 判定根拠

設計の core (完了世代のみ publish・前後 fingerprint・atomic write・legacy fail-closed・証跡≠権威) は計画 §3.3/R12 の全要求を満たし、安全性を弱める経路がない。残る指摘は「正直さの文書化」「fingerprint 対象範囲と mode の関係」「将来 schema 進化の固定」という条件レベルであり、rework を要する設計欠陥ではない — よって **approve-with-conditions**。
