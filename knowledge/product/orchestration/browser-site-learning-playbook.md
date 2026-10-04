---
title: Browser Site Learning Playbook (新規サイト→リプレイ可能ADF)
category: Orchestration
tags: [orchestration, browser, discovery, scratch, adf, recording, playbook]
importance: 9
author: Kyberion Engineering
last_updated: 2026-10-04
---

# Browser Site Learning Playbook（新規サイト → リプレイ可能ADF）

新規サイトの使い方を学習し、リプレイ可能な ADF に落とすための正規フロー。
`browser-discovery-playbook.md`（Inspect 手順）と `adf-pipeline-learning-playbook.md`（学習ループ）、
`pipeline-crystallization-loop.md`（Explore→Freeze）、`scratch-to-pipeline-video-promotion.md`（昇格の形）を
ブラウザ用に統合したもの。AGENTS.md の「discovery は scratch-first（semantic-brief-first）」の実装でもある。

運用上の正本は [Browser Automation Operating Checklist](./browser-automation-best-practices.md)。
開始前の成功条件・承認範囲、各操作後の結果確認、結果不明時の再確認、秘密を残さない再開記録は
全経路で同じチェックリストに従う。本書は学習・録画・昇格の経路を扱う。

## 0. 3経路の使い分け（最初に決める）

| 経路                 | 入口                            | 向く場合                                                    | 出口                                                           | 禁止                                      |
| :------------------- | :------------------------------ | :---------------------------------------------------------- | :------------------------------------------------------------- | :---------------------------------------- |
| **A. Inspect手書き** | `browser inspect`               | 静的/単純フォーム、セレクタ特定が主目的                     | 手書き正規ADF → `browser run --adf`                            | 複雑SPAを盲目的に手書き                   |
| **B. Scratch試行**   | headed/CDP + tmp ADF            | 見た目・セレクタ・フローが未知、WAF/認証/SPAsの振る舞い不明 | 受理された手順 → 正規ADF/録画へ昇格                            | 未受理のまま `pipelines/` へ昇格          |
| **C. 人間実演録画**  | 拡張機能 (browser-recording.v1) | Bot対策が厳しい、操作が複雑、人手の承認が必要               | `promote-procedure` → `browser run --procedure-id/--recording` | 録画ドラフトを `--adf` に渡す（承認迂回） |

迷ったら **A → B → C** の順に軽い方から試す。Bで固まったら A/C のどちらへ寄せるかを決める。

## 1. Inspect First（軽量調査）

```bash
pnpm kyberion browser inspect <url> --mode fetch        # 静的HTMLの高速把握
pnpm kyberion browser inspect <url>                     # Playwrightで hydration後のDOM解析 (default)
pnpm kyberion browser inspect <url> --mode cdp           # 起動中Chromeにアタッチして調査
pnpm kyberion browser inspect --mode extension          # Akamai/Cloudflare等では拡張経由
```

出力（title/最終URL、inputs、buttons、h1-h3、links、text抜粋）から
認証・WAF・動的レンダリングの有無を判定する。ここでは ADF を書かない。

## 2. Scratch試行（未知が残る場合のみ）

未知（セレクタ不安定、待機条件不明、遷移分岐あり）が残る場合、ADF化せず scratch で試す。

- headed で目視: `browser inspect <url> --headed --screenshot active/shared/tmp/<slug>-scratch.png`
- または CDP 接続の既存Chromeで手操作し、DOM差分を目視
- 試行メモは `active/shared/tmp/<slug>-scratch.md` に残す（一意な対象候補、待機条件・上限、成功条件、ハマり点）。機密・個人情報の証跡は必要範囲に最小化・秘匿化し、所属する mission の tier/tenant 内に置く。認証秘密は保存しない
- 再生対象は検証済みの操作列だけにする。失敗・結果不明の試行は、重複操作を避けるため必要な原因・試行回数・未確定効果だけを秘匿化して証跡に残す

受理条件（全て満たしたら昇格可）:

1. 操作順序が固定できた
2. 対象操作の一意な `selector + role/name` が特定できた
3. 待機条件（`waitUntil` と対象状態／待つセレクタ）、上限時間、結果の確認方法が言語化できた
4. 認証・WAF・2FA の扱い（許可されたプロファイル再利用か `pause_for_operator` か）が決まった
5. 実際の成功条件と副作用、承認境界、停止・再開時の確認手順が決まった

## 3. Record（証跡を残す）

受理された手順を2つのどちらかで記録する。

**B1. 自走trail（Playwright自走の場合）:**
最小ADFに `export_adf` / `export_playwright` を付けて実行すると
`ctx.action_trail` が `active/shared/tmp/browser/<session>-pipeline.json` に出る。

```json
{
  "action": "pipeline",
  "pipeline_id": "scratch-verify",
  "session_id": "scratch-verify",
  "steps": [
    {
      "id": "open",
      "type": "control",
      "op": "browser:open_tab",
      "params": { "url": "{{source_url}}", "select": true }
    },
    { "id": "snap", "type": "capture", "op": "browser:snapshot", "params": {} },
    {
      "id": "export",
      "type": "transform",
      "op": "browser:export_adf",
      "params": { "export_as": "exported" }
    }
  ]
}
```

**B2. 人間実演（拡張機能の場合）:**
Sidepanelで録画 → レビュー承認 (`review.status=approved`) →
`promote-procedure` で `ProcedureEntry` + `pipelines/browser/<id>.json` に昇格。
`browser run --procedure-id|--recording` で再生する。

## 4. Crystallize（正規ADFに固める）

trail/録画をそのまま使わず、正規形に整える。

- `control:browser:open_tab` → `capture:browser:snapshot` → `apply:browser:click|fill|press|wait` → `apply:code:write_artifact`
- `open_tab` と `snapshot` は同一 `session_id`、snapshot後に `about:blank` でないことを確認
- 対象操作（click/fill/press）には観測で確認した `selector + role/name` を付与、`@eN` 単独を残さない。待機は対象状態の selector/state を指定する
- secret は `browser:fill_secret_ref` + `dom_path` + `secret_ref`（`dom_path`なしは除外= fail-closed）
- 遷移後は `wait`（セレクタ・状態・timeout）と観測で準備完了を確認する。media-heavy サイトの `waitUntil: load` は背景通信の待ち過ぎを避ける設定であり、業務上の成功判定ではない
- 再実行が危険な副作用のある step は対応する経路の retry を抑止する（Playwright ADF の `params.max_retries: 0` 等）。外側の再実行も含め、結果不明なら readback を先に行う
- `screenshot` は証跡として保持される。`scroll` / `select_tab` は現exporterでは意図的に落とす（wheel-delta再演不可 / ephemeral tab_idのため）。必要なら `wait` + `snapshot` アンカーで置き換え、`select_tab` は `select_tab_matching` で記録し直す

## 5. Verify（安全な入力で再現性と結果を確認する）

- 許可された対象環境（sandbox 優先）で実行し、スナップショットが `about:blank` でないこと
- 読み取り専用／sandbox／安全にリセット可能な入力で2回実行し、構造（手順順・フィールド有無・artifact有無）と成功条件を比較する（[学習Playbook §2 Step 7](./adf-pipeline-learning-playbook.md)）。実サービスへの送信・購入・承認等を検証のために重複実行しない。実操作の反復は個別の権限確認と重複効果の確認が必要
- 失敗時は `export_failure_bundle` の trail を秘匿化して確認し、load／dispatch／実行時のどこで止まったかを分類する。timeout・切断後の効果は失敗と断定せず、正本の「結果不明→readback→再試行判断」に従う

## 6. Promote（再利用する場合のみ昇格）

| Scratch成果物          | Pipeline target                                                   |
| :--------------------- | :---------------------------------------------------------------- |
| 確定した操作順序       | ADF `steps`（正規op形）                                           |
| `selector + role/name` | 各 apply の `params`                                              |
| 待機条件               | `wait` step / `waitUntil`                                         |
| 認証手順               | `options.profile` または `pause_for_operator` + `session_handoff` |
| 最終確認スクショ       | evidence添付のみ（gitにバイナリを入れない）                       |

- 自走ADF → `pnpm pipeline:promote` で `pipelines/<slug>.json` へ（ADFのみ対象）
- 録画 → `promote-procedure` パイプラインで procedure + `pipelines/browser/<id>.json` へ
- 使い捨ては `active/shared/tmp/` に残したまま昇格しない

## 7. 初学者向け最小チェックリスト

- [ ] `inspect` で inputs/buttons/links を特定した
- [ ] 未知が残れば scratch で試し、受理条件 (§2) を満たした
- [ ] 正規op形で書いた（`open_tab` は `control`、`snapshot` は `capture`）
- [ ] 同一 `session_id` で `about:blank` でないことを確認した
- [ ] 対象操作の `selector + role/name` と、待機対象の状態を確認した
- [ ] 正本の成功条件・承認・結果確認・再開チェックを満たした
- [ ] 安全な入力で再現性と結果を比較し、実サービスに重複した副作用を起こしていない
- [ ] 再利用する場合のみ昇格した（ADF↔録画の rails を混ぜない）

関連: [Browser Discovery](./browser-discovery-playbook.md) · [ADF Learning](./adf-pipeline-learning-playbook.md) · [Crystallization Loop](./pipeline-crystallization-loop.md) · [実行基盤 howto](../architecture/browser-execution-substrate-howto.md)
