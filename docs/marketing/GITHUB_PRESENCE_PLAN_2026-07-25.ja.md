# GitHub プレゼンス整備計画(2026-07-25)

> **目的**: 2026-07 に完了したアーキテクチャ群(goal-driven worker・context pack・provenance ゲート・メディア生成プロセス等)を、GitHub 上の対外情報に反映する。
> **状態**: description / topics は **2026-07-25 適用済み**(§2.1 の案 + `multi-agent` `ai-agents` `typescript` `mcp` 追加を確認済み)。**Release / Discussions への投稿と Social preview は未実施** — §3 / §2.3 をオーナー判断で公開する。
> **恒常化**: リリースハイライトの生成は今後リリースごとに繰り返すため、`pipelines/` 化の候補(traces → STATUS 差分 → ハイライト草稿の半自動生成)。

## 1. 現状スナップショット(2026-07-25 時点)

- 公開状態: **public**
- description: `Open-source organization work loop engine for governed agent orchestration, browser automation, and voice workflows.`
- topics: `agent-orchestration` `audit-trail` `browser-automation` `knowledge-management` `llm-agents` `open-source` `rpa` `self-hosted` `voice-automation` `workflow-automation`
- README: マーケティング構成済み(differentiators / comparison / roadmap)。2026-07-25 に「Workers get briefed, not dumped」「Goal-driven workers」「Provenance-gated plugins」「Design-system-governed media」を追記済み。

## 2. 推奨変更(要承認)

### 2.1 リポジトリ description 更新案

現行は browser/voice 中心で、2026-07 の自律実行・自己改善の要素がない。案:

> Open-source organization work loop engine — governed multi-agent orchestration with goal-driven workers, evidence-gated missions, and an organizational memory that improves every run.

(140 文字制限内。browser/voice は topics と README に任せ、description は差別化軸に寄せる)

### 2.2 topics 追加案

追加: `multi-agent` `ai-agents` `typescript` `mcp`(MCP server 同梱のため)
現行 10 + 追加 4 = 14(上限 20 内)。削除候補なし。

### 2.3 社会的プレビュー(Social preview)

`docs/assets/kyberion-loop.svg`(work loop 図)を 1280×640 PNG に書き出して設定する。タグライン候補:

- "You phrase outcomes. It plans, runs, and remembers with evidence."
- "The agent org that improves itself."

## 3. リリース / Discussions 用ハイライト草稿(2026-07)

GitHub Release(タグ運用開始時)または Discussions announcement 用。英語正文 + 日本語要約の二部構成。内容はすべて [STATUS.ja.md](../developer/improvement-plans-2026-07/STATUS.ja.md) で DONE 検証済みの実装に基づく。

---

### July 2026 highlights — the work loop closes

**Autonomous workers, governed.** Mission tasks can now opt into _goal-driven execution_: a per-worker goal state machine (active / paused / blocked / complete) with token, turn, and wall-clock budgets, a grace step for clean final reports, and structured termination signals — no more "the model decided it was done". Worker state is _event-sourced_: every step lands in an append-only journal, so a restarted worker resumes exactly where it left off instead of starting over.

**Workers get briefed, not dumped.** Dispatch now delivers a role-scoped _mission context pack_ — mission goal, acceptance criteria, top knowledge hints distilled from previous runs — under an explicit size budget with automatic compaction on long runs. Knowledge retrieval ranks by document authority, scope, and freshness.

**Trust is derived, not declared.** Skill plugins install through managed copies with _provenance-derived trust_: official sources activate, third-party sources require explicit human approval, and the loader structurally refuses anything hand-copied around the gate. Untrusted input reaching worker prompts is framed and escaped by contract.

**Media that stays on-brand.** PPTX and video are authored as semantic briefs against a single design-token cascade: text-measured layout fitting (no more overflowing text boxes), a governed motion vocabulary for video, and lint gates before render. The design system decides styling; the model decides content.

**Throughput without chaos.** Tool calls declare the resources they touch and a scheduler parallelizes what can't conflict. Prompt-cache discipline keeps stable prefixes stable, cutting repeat-token cost on long missions.

_All of the above is verified by hermetic test suites (200+ new tests this cycle) and recorded in the improvement-plan status ledger — the same evidence discipline the engine enforces on its own missions._

---

**日本語要約**: ミッションのタスクは opt-in で goal 駆動の自律実行(予算付き状態機械+イベントソーシング復元)が可能になり、ワーカーには役割スコープの context pack(ゴール・受入条件・過去実行から蒸留したナレッジヒント)が予算内で配給されます。プラグインは取得元由来の信頼導出+managed-copy 隔離で、第三者コードは人間の承認なしに実行されません。PPTX/動画はセマンティックブリーフ+単一デザインカスケードで生成され、テキスト計測レイアウトであふれを根絶。ツール呼び出しはリソース宣言に基づいて安全に並列化されます。

## 4. 適用手順(承認後)

```bash
# description / topics(要承認: 対外変更)
gh repo edit famaoai-creator/kyberion \
  --description "Open-source organization work loop engine — governed multi-agent orchestration with goal-driven workers, evidence-gated missions, and an organizational memory that improves every run."
gh repo edit famaoai-creator/kyberion --add-topic multi-agent --add-topic ai-agents --add-topic typescript --add-topic mcp

# Discussions announcement(Release タグ運用開始前の暫定)
# §3 の草稿を Discussions > Announcements に投稿

# Social preview は GitHub Settings > Social preview から手動アップロード
```

## 5. 継続運用への接続

- **リリースハイライトの半自動化**: STATUS.ja.md の日付付き追記 → ハイライト草稿の生成は決定論的な入力(差分抽出)+モデル判断(マーケ文言化)の構成なので、`pipelines/` のセマンティックブリーフ型 pipeline に昇格する(AGENTS.md「Promote repeated deterministic work into a pipeline」)。
- **KP 計画との関係**: 対外発信そのものが「どの実装が完了しどこに証拠があるか」を STATUS に依存している。KP-05/06(帰還テレメトリ・キュレーション)が入ると「実運用で効いている機能」をデータで語れるようになり、マーケ文言の裏付けが強くなる。
