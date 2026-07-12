# origin/main 実装レビュー & 正しいコードの書き方(2026-07-04, Fable 5)

> **対象**: 改善計画を **gpt-5.4-mini(medium)/ gpt-5.5(medium)** で実装し origin/main(HEAD 74f85d09)に上げたもの。実装は途中。
> **方法**: カテゴリ別に並列レビュー(UX/KM/AC/OP・オーケストレーション・セキュリティ)→ 争点と高深刻度は Fable が `git show origin/main` で実コード裏取り。
> **前提の訂正(誠実さ)**: セキュリティレビューは「ADF ガードレールが未配線」と判定したが**誤り**。`readValidatedPipelineAdf`(`scripts/refactor/adf-input.ts:33-45`)が `validatePipelineGuardrails` を呼び error severity で throw し、`run_pipeline.ts:1268` がそれを実行前に呼ぶ — **ガードレールは配線済み**。本文書はレビュー結果を鵜呑みにせず訂正している。

---

## 0. 総括 — 「形は揃うが実効性が空洞」

軽量モデル(gpt-5.4-mini/5.5 medium)による実装は、**プランの形(関数・スキーマ・テスト・配線の枠)はほぼ揃えたが、実際に効く enforcement が空洞**、という一貫したパターンを示す:

- ゲートが**既定で無効**(SA-04 egress `mode:warn`、MO-05 enforce が `advisory` 既定)
- ゲートが**自己ゲーミング**(acceptance を「復唱せよ」と指示した上で部分文字列一致で判定)
- ゲートが**回避可能**(SA-01 HMAC が self-declared `sha256` で keyless 検証にダウングレード可能)
- ゲートが**素通し**(file-actuator の未知 op が `status:success`)
- テストが **shape を assert するが runtime enforcement を検証しない**

これは私の [ORCHESTRATION_HARNESS_MODEL](../ORCHESTRATION_HARNESS_MODEL.ja.md) / [FABLE5_AGENT_MODEL](../FABLE5_AGENT_MODEL.ja.md) の予測そのもの:「**強いモデルは雑な依頼を補完するが、軽量モデルは補完しない**」。プランが「warn→enforce の段階導入」「acceptance を検証する」と書いても、軽量モデルは**最初の観測段階(warn/advisory/shape)で止め、完了条件(enforce・実検証)まで到達しない**。対策は §3(プランの受入条件を「enforce に到達」まで機械可読にする)。

---

## 1. 実装状況(検証済み per-item)

| 計画                                   | 状態              | 実効性                                                                                                                                                                         |
| -------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| UX-05(omitted count)                   | ✅ WIRED          | 正しく配線・テストあり                                                                                                                                                         |
| KM-03(promotion queue + hints archive) | ✅ WIRED          | 上書きせず追記+50超をアーカイブ。正                                                                                                                                            |
| KM-01(janitor cron)                    | ✅ WIRED          | `storage-janitor.json` に `cron:"30 4 * * *"` 等。稼働                                                                                                                         |
| AC-03(deploy config)                   | ✅ WIRED          | 既存 `ShellDeploymentAdapter` を再利用(重複なし)。正                                                                                                                           |
| daemon-heartbeat                       | ✅ WIRED          | produce(daemon×2)→consume(watchdog)の完全ループ                                                                                                                                |
| OP-02(tenant export)                   | ✅ WIRED(薄)      | `backup.ts` に委譲+強制暗号化。動くが 29 行の糖衣                                                                                                                              |
| adf-guardrails 配線                    | ✅ WIRED(静的)    | run_pipeline 実行前に throw。ただし**静的検証**(runtime PII/content scan ではない)                                                                                             |
| SA-05(kill-switch/approval)            | ⚠ 概ね WIRED      | kill-switch は実給電。approval は fail-closed 化。ただし §2-D の矛盾ログ、policy-engine は file_write のみ                                                                     |
| UX-03(明確化ローカライズ)              | ⚠ PARTIAL         | 主要プロンプトは catalog 経由。だが profile 質問は英語ハードコード、contextual reason は**ソース内に日本語直書き**(catalog 非経由)、catalog miss で生キー漏れ                  |
| MO-05(model/effort routing)            | ⚠ PARTIAL         | hint 計算は本物。だが enforce が**既定 advisory**(env フラグ未設定で shadow)。effort が delegateTask 経路に未適用                                                              |
| MO-07(deliverable quality)             | ⚠ PARTIAL         | finish ゲートに配線(完了ブロック)。だが rubric が**自己申告フラグ依存**で gameable、`evaluateDeliverableQualityGate` は dead export、redo なし、policy 欠落で silent {ok:true} |
| a2a-task-contract                      | ⚠ PARTIAL         | 送信+受信スキーマ検証は本物。だが**出力を acceptance_criteria で検証しない**(request 形状のみ)、非 contract-like で fail-open                                                  |
| SA-01(audit chain HMAC)                | ⚠ HOLE            | HMAC 鍵付き・tail seed は正。だが**ダウングレード攻撃**: verify が self-declared `chain_alg:sha256` を keyless 検証。alg-floor 未実装                                          |
| SA-02(shell/ADF guardrail)             | ⚠ MIXED           | サブエージェント Bash は fail-closed(正)。ADF ガードレールも配線済(上記訂正)。だが acp-mediator は依然 title の部分文字列判定                                                  |
| SA-04(egress control)                  | ❌ 空洞           | 全 secureFetch に allowlist 適用は正。だが**既定 `mode:"warn"`** で非許可ホストも素通し。enforce 未到達                                                                        |
| AC-01/AR-06(silent no-op)              | ❌ 未修正         | prettier 整形のみで挙動不変。`opApply`・`switch(step.type)` に default なし、未知 op が `status:success`(`file-pipeline-helpers.ts:208/277/301`)                               |
| mission-workitem-dispatch acceptance   | ❌ 自己ゲーミング | `:203` で「各受入条件を明記せよ」と指示 → `:531` が部分文字列一致で判定 → **復唱すれば必ず通る**。検証していない                                                               |

---

## 2. コードの正しい書き方(高深刻度から)

### A. acceptance ゲートの自己ゲーミング(最優先・correctness バグ)

`mission-workitem-dispatch.ts:203` がエージェントに「各受入条件を応答に明記せよ」と指示し、`:531` が `!evidence.includes(criterion)`(応答文の部分文字列)で判定。**エージェントが基準文を復唱するだけで通る** — ゲートに見えて何も検証していない。

**正しい書き方**: 「応答テキストに基準文字列が含まれるか」でなく「**成果物が基準を満たす証拠があるか**」を判定する。

```ts
// ❌ 現状: 応答の部分文字列(復唱で通る)
const missing = criteria.filter((c) => !evidence.includes(c));

// ✅ (a) 構造的証拠: 成果物の存在 + 種別一致 で判定
//     acceptance_criteria を「検証可能な述語」として書かせ、成果物メタ/ファイル存在/テスト結果で確認
const results = await Promise.all(
  criteria.map((c) =>
    checkCriterionEvidence(c, {
      artifacts: producedArtifacts, // 実際に生成されたファイル
      testReport, // IP-03 のテスト実行結果
    })
  )
);
// ✅ (b) 非stub時のみ: 独立 judge に「この成果物は基準Xを満たすか。満たさない点は何か」を問う
//     (実装者の応答文でなく、成果物そのものを渡す)
const verdicts = reasoningBackend.isStub
  ? results
  : await Promise.all(criteria.map((c) => judgeCriterion(c, producedArtifacts)));
```

そして `:203` の「各基準を復唱せよ」addendum は**削除**する(判定を汚染するため)。判定は応答文でなく成果物に対して行う。IL-04(完了突合)/ MO-07 と同じ「成果物を動かして/突き合わせて確認」原則。

### B. SA-04 egress を enforce に(fail-open の解消)

`egress-policy.json:3` が `mode:"warn"` で、非許可ホストへの送信が素通し。plan の完了条件は enforce。

**正しい書き方**: allowlist を service preset 由来で十分に埋めた上で `mode:"enforce"` に。移行は `KYBERION_EGRESS_POLICY=warn|enforce` の env でなく**ポリシーの `mode` を warn で観測 → 非許可ホスト一覧を allowlist に取り込む → `mode:"enforce"` に切替**、を完了条件として明記(§3)。`network.ts:132-138` の warn 分岐は残すが、既定ポリシーは enforce にする。confidential 文脈は tenant allowlist 照合(SA-04 Task 2)。

### C. SA-01 ダウングレード攻撃(alg-floor)

`verify()` が各エントリの self-declared `chain_alg` を信じ、`sha256` を keyless 検証(`audit-chain.ts:225-230`)。攻撃者が tail を `chain_alg:"sha256"` に書き換え平文ハッシュを再計算すれば verify が通る = HMAC の意味が消える。

**正しい書き方**: **移行境界(cutover)以降は `hmac-sha256` を必須**にする。

```ts
// 移行境界エントリ(genesis 後に1つ挿入)の ts/index を記録
// verify() 内:
if (entryTs >= HMAC_CUTOVER_TS && entry.chain_alg !== 'hmac-sha256') {
  return {
    ok: false,
    reason: `alg downgrade at ${entry.id}: expected hmac-sha256, got ${entry.chain_alg}`,
  };
}
```

過去の sha256 エントリは再ハッシュせず(それ自体が改ざん)、境界以降のみ alg-floor を強制。あわせて `audit:verify` を `validate`/CI ゲートに入れる(現状は script + 日次のみ)。

### D. secure-io の矛盾ログ(将来の fail-open 回帰の罠)

`secure-io.ts:213` が「allowing by default」とログした直後の `:216` で `throw`(fail-closed 化・正)。**ログと挙動が矛盾**し、将来の編集者が「ログどおり fail-open に戻す」誘因になる。

**正しい書き方**: ログを挙動に一致させる。

```ts
// ❌ logger.warn(`... allowing by default ...`); throw new Error('Policy engine unavailable ...');
// ✅
logger.error(
  `[secure-io] policy engine unavailable; DENYING write (fail-closed): path=${resolved} error=${err?.message}`
);
throw new Error(`Policy engine unavailable for ${resolved}: ${err?.message || err}`);
```

### E. AR-06 file-actuator の silent no-op(未修正)

`opApply`・`switch(step.type)` に default が無く(or `default: return ctx`)、未知 op が `status:success`(`file-pipeline-helpers.ts:208/277/301`)。prettier 整形のみで挙動不変。

**正しい書き方**: 未知 op は**エラー**(status:failed + 近い op を suggest)。正当な条件不成立は `skipped`(理由付き)で区別。

```ts
// ❌ default: return ctx;   // 素通し=成功偽装
// ✅
default:
  throw new PipelineOpError(`未対応の op: ${op}`, { known: KNOWN_OPS, suggestion: nearest(op, KNOWN_OPS) });
// step.type switch にも同様の default を追加(未知 type を success にしない)
```

AR-06 の warn→enforce に従い、まず log+skip で誤字テンプレを洗い、error 化。

### F. MO-05 enforce 既定 + effort の delegateTask 経路

`agent-lifecycle.ts:118-129` が `KYBERION_TASK_MODEL_ROUTING==='enforce'` の時のみ hint を適用、既定 `advisory` で誰もフラグを立てず shadow のまま。effort は ClaudeAdapter 経路のみで `backend.delegateTask`(subagent 経路)に未適用。

**正しい書き方**: shadow 観測で precision を確認したら**既定を enforce に**(or 少なくとも fast tier のみ enforce を既定に)。effort は delegateTask にも渡す:

```ts
// delegateTask シグネチャに effort を追加し、両経路(ClaudeAdapter spawn / delegateTask)で同一 hint を適用
backend.delegateTask(prompt, { taskId, effort: hint.effort, model: hint.model_id });
```

`resolveReasoningModelRoute` の `model_route_status:'shadow'` ハードコード(intent-compiler 経路)と、task-model-hint 経路を混同しないこと。

### G. MO-07 の gameable rubric + dead export + fail-open

rubric が自己申告フラグ(`build_passed` 等)依存で、フラグ不在時は soft warn のみ。`evaluateDeliverableQualityGate` は 0 consumer(dead)。`security-policy.json` に `quality_requirements` が無いと silent `{ok:true}`。

**正しい書き方**: (1) code/media の品質は自己申告でなく**実測**(IP-03 のテスト/lint 実行結果、AR-03 のスキーマ適合)を入力にする。(2) dead export を削除し live ゲート(`mission-governance.ts`)に一本化。(3) policy 欠落時は fail-open(silent ok)でなく、既定ルーブリックを適用(judgment 文書の fail-closed 原則)。

### H. UX-03 のローカライズ漏れ

contextual reason がソース内に日本語直書き(`question-resolver.ts:139-171`、catalog 非経由)、profile 質問は英語ハードコード、`renderVocabularyText` が catalog miss で生キー漏れ。

**正しい書き方**: reason/profile 質問も `user-facing-vocabulary.json` の en/ja エントリに移す(ソース直書きを排除)。`renderVocabularyText` の miss は生キーでなく fallbackEn or 「(未訳)」+ログに。

---

## 3. 軽量モデルに実装させる時の指針(再発防止)

今回の空洞化は**プランの受入条件が「観測段階(warn/advisory/shape)」で満たせてしまう**のが根因。軽量モデルはそこで止まる。プラン側を機械可読な完了条件にする:

1. **受入条件に「enforce 到達」を明記**: 「warn で観測」は中間、完了は「既定 enforce + 非許可を deny するテスト」。DoD に「`mode:"enforce"` かつ enforce-deny のテストが緑」を書く。
2. **ゲートのテストは runtime enforcement を検証**: shape(関数が存在・スキーマが通る)でなく「不正入力が実際に **block される**」ことを assert。今回の egress/quality テストは warn/shape のみで、この差が空洞を見逃した。
3. **acceptance/quality は「応答文」でなく「成果物」を検証**: 応答の部分文字列・自己申告フラグは NG。成果物の存在・テスト結果・(非stub時)独立 judge を入力にする。判定を汚染する「復唱せよ」的プロンプトを禁止。
4. **fail-open を残さない**: config/policy 欠落時の既定は deny or 既定ルーブリック。silent `{ok:true}`/`warn` を既定にしない。ログと挙動を一致させる。
5. **「dead export / 二重経路」を作らない**: ラッパーを書いたら consumer に配線するか消す。今回 `evaluateDeliverableQualityGate` が 0 consumer。

→ 個別の修正コード例は §2。これらは軽量モデルにも渡せる粒度(具体的な old→new)にしてある。
