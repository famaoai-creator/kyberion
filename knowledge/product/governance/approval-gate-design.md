---
title: 'Approval Gate Design: Store First, Surface as Renderer'
tags: [governance, approval, mission, gate, human-in-the-loop]
last_updated: 2026-10-09
---

# Approval Gate Design

人間承認を伴うゲートは、承認の保存・判定と、人間向けの表示・入力を分離する。新しい承認 UI を作るときは、先に共有 `approval-store` のリクエスト契約を作り、サーフェスはそのリクエストを描画する renderer として接続する。

## 原則

1. **Store first**: `mission_gate` などの承認リクエストを共有 approval-store に作成し、対象 payload のハッシュを記録する。サーフェス固有の承認ストアや決裁 API は追加しない。
2. **Surface is not authority**: HTML、ブラウザ状態、`data-decision`、ローカルの保存ファイルは表示・入力の一時表現であり、承認の正本ではない。決定は既存の approval-store の決定 API を通して保存する。
3. **Hash-bound approval**: 承認対象が変わったら同じ承認を再利用しない。ゲートは approval-store の決定と、現在の brief のハッシュが一致することを確認する。
4. **Explicit machine gate**: 承認ゲートは `command_succeeds` で strict な判定コマンドを実行する。コマンドは approval-store、ハッシュ、必要な認証強度を確認し、失敗時にミッションを進めない。
5. **Do not widen legacy behavior**: 既存の `reviewer_approved` や `human_override` の `humanConfirmed` 自動充足を、既存ゲート全体で一括変更しない。新しいゲートは command-based な証拠を選び、既存挙動の段階的な移行は別の変更として扱う。

## Mission alignment への適用

`mission_controller create` は planned 状態のミッション容器を作るライフサイクル操作であり、承認そのものでも実行開始でもない。既存の `mission_controller start` は active 化する操作なので、この承認フローでは使わない。`ALIGNMENT_APPROVED` の `command_succeeds` ゲートが最初に成功したときだけ planned から active へ遷移する。ブラウザや UI から create/start を直接呼び出さない。

標準経路は次のとおり。

```text
mission brief
  -> approval-store request + payloadHash
  -> approved surface decision
  -> strict command_succeeds check
  -> first gate pass: planned -> active
```

この分離により、サーフェスを追加・交換しても、承認の監査記録とゲートの判定契約は共有のまま保てる。

## 職務分離（separation of duties）

依頼者が自分の依頼を承認できるかどうかは policy で選ぶ。設定は
`knowledge/product/governance/approval-policy.json` の `separation_of_duties.enabled`（既定 `false`）。

- **OFF（既定）**: 従来どおり。Kyberion は 1 人の operator で運用されることが多いため、依頼者本人の承認も通る。
- **ON・決定時**: approval-store の `decideApprovalRequest` が、承認（`approved`）の決定を次の場合に
  `[POLICY_VIOLATION] Separation of duties: …` で拒否する。拒否は監査台帳（`approval_decision` /
  `separation_of_duties`、`result: denied`）と、その channel の approval イベントログ
  （`separation_of_duties_refused`）に記録され、依頼は `pending` のまま残る。
  - 決定者が依頼者と同じ principal（`self_approval`）。
  - 依頼に依頼者の identity が記録されていない（`missing_requester`、fail closed）。
  - 決定者の identity が空、または surface の代替値（`missing_decider`）。代替値の一覧は
    `APPROVAL_PLACEHOLDER_DECIDERS`（`concierge`、`chronos-localadmin`、`sovereign-user` など）の 1 か所にある。
  - 決定者の identity を呼び出し側が自由文字列で渡す surface（`unverified_decider`）。決定に
    `deciderIdentitySource: 'caller_supplied'` を記録する surface は次の 2 つだけで、ON ではここから承認できない。
    - `libs/core/governance/approval-cowork-adapter.ts`（MCP の `kyberion.approval.decide`）
    - `libs/actuators/approval-actuator/src/approval-actuator-helpers.ts`（approval-actuator の `decide` op）
  - mission brief の承認ページ（`scripts/mission-alignment-gate/serve-brief.ts`）は、ページの token が
    所持しか証明しないため、決定者をページから受け取らない。CLI と同じ `resolveCliOperatorIdentity()`
    （下記の operator principal）でサーバー側が決め、ページで入力された名前は note に残すだけ。agent の
    セッション内で起動したサーバーは、ON では承認を受け付けず、OFF では決定を `caller_supplied`（agent の
    principal 付き）として記録する（端末と同じ規則）。
- **CLI の identity**: 端末（CLI と script）は 1 つの operator principal を使う
  （`libs/core/governance/cli-operator-principal.ts`）。この machine の owner member（chronos /
  presence-studio の loopback viewer と同じ member）を `user:<member_id>` として、CLI や script が依頼を
  開くときの `requestedBy` と、`pnpm kyberion approvals --approve`（`pnpm kyberion approve` も同じ）の
  `decidedBy` の両方に記録する。onboarding の表示名は `requestedByDisplayName` / `decidedByDisplayName`
  に別に残し、比較には使わない。
  - agent のセッション内（`KYBERION_AGENT_ID`、`KYBERION_NHI_ID`、`KYBERION_RUN_ORIGIN=agent`、または
    `CLAUDECODE` などの provider CLI の目印）で CLI が依頼を開くと、依頼者は `agent:<…>`
    （例 `agent:claude-code`）になる。そのため agent が開いた依頼を人が承認しても自己承認にはならない。
  - 検出した principal（agent のセッション、なければ owner member）は常に
    `requestedByContext.actorId` に記録する。明示の `--requested-by` は `requestedBy` になり、identity を
    1 つ足すだけで、検出した principal を置き換えない（`approvalRequesterIdentities` は両方を見る）。
    owner が `--requested-by agent:x` で依頼を開いて自分で承認しても、自己承認として拒否される。
  - 依頼者の解決は CLI の入口で行い（`scripts/lib/cli-approval-requester.ts`、
    `scripts/lib/cli-attestation-invoker.ts`）、library（mission の scope-approve と reconcile-work、
    provider attestation、project trust、plugin install、service recording）は解決済みの依頼者を引数で
    受け取る。依頼を実際に開くときだけ解決する（既存の依頼を再利用するとき、official plugin のように
    依頼が要らないときは解決しない）。
  - owner member が無いとき: OFF では従来の値（persona、component 名、表示名）を記録する。ON では依頼も
    承認も `[POLICY_VIOLATION] approval … blocked — … no stable operator identity` で止まり、
    `pnpm organization member ensure-owner`（owner member を作る。冪等）を案内する。代替値で記録はしない。
  - ON で、agent のセッション内から `--approve` すると止まる（agent が人の代わりに決めないため。セッション内
    では両者を区別できない）。自分の端末から実行する。却下は止めない。
  - ON で端末から承認するには、対話的な端末（stdin と stdout がともに TTY）で、依頼の要約と一緒に表示される
    使い捨てのコードを入力する必要がある（`scripts/lib/approval-cli-decision.ts`）。一致したときだけ承認し、
    決定に `decidedVia: 'cli_tty_challenge'` を記録する。省略するフラグは無い。TTY が無いときは、認証済みの
    surface（Chronos か presence-studio）を案内して拒否する。`pnpm kyberion approve`、
    `service_recording review --approve` も同じ helper を通る。OFF では従来どおりで、確認は求めない。
  - OFF で agent のセッション内から決定すると、`decidedBy` は owner のまま、`deciderIdentitySource:
'caller_supplied'` と `decidedInAgentSession`（agent の principal）を記録し、監査台帳にも残す。後で ON に
    すると、このレコードは `unverified_decider` として利用時に拒否される。
  - この identity を使う依頼の作成元: `pnpm onboarding llm attest … --request-approval`（provider
    attestation）、`pnpm kyberion project-trust request`、`pnpm kyberion hooks trust`（external hooks）、
    `kyberion secret introduce`、mission の `scope-approve --request-approval` と `reconcile-work`、
    organization decision の `transition … --request-approval`、`entity_governance_cleanup` と
    `audit_mirror_reconcile` の `--request-approval`、`pnpm plugin:install`（third-party）、
    `service_recording capture` / `request-review`。
- **承認の取り消し（revoke）**: `pnpm kyberion approvals --revoke <id> [--reason "…"]`
  （`libs/core/governance/approval-revocation.ts`）は承認済みレコードを取り消し、以後の利用を拒否する。
  すでに起きた効果は元に戻らない。
  - status は `approved` のまま（決定があった事実は証跡として残る）で、`revocation`（誰が・いつ・理由）が
    付く。`evaluateApprovalUsability` は SoD の設定に関係なく取り消されたレコードを拒否するので、下記の
    すべての consumer で以後の効果にならない。再依頼の入口は取り消されたレコードを返さず、新しい依頼を開く。
    session cache の付与も消える。
  - 取り消せる人: 依頼者（自分の依頼の取り下げ。cancel と同じ）、承認した principal（自分の決定の
    取り下げ）、または local owner。owner の権限は呼び出し側が主張できず、`revokeApprovalAsLocalOwner` が
    member registry（loopback の owner member）からサーバー側で解決する。CLI は agent のセッションでなく
    owner member があるときにこれを使う。取り消しは権限を減らすだけなので、そのレコードに責任を持つ人なら
    誰でもよい、という承認の責任モデルに合わせた。surface の代替値は identity にならない。
  - 一度きりの効果（one-shot）: apply claim を取る consumer（`apply_claim`）に加えて、claim を取らない
    one-shot の consumer は効果の直前に `markApprovalConsumed` で消費を記録する。対象は
    `service_recording_promotion`（procedure の登録）と `organization_decision`（承認済み決定の保存）。
    消費済みの承認は 2 回目の利用も revoke も拒否される（revoke は「すでに消費済み」と報告する）。
    それ以外の claim を取らない consumer は、効果のたびに利用可否を確かめ直す（例: `pipeline_bound_approval`
    は run の再開のたびに確かめる）ので、revoke 以降の利用が拒否される。それ以前の利用は取り消せない。
  - 取り消せないもの: pending（cancel を使う）、rejected などの承認以外、claim 済み・適用済み・消費済み
    （一度きりの効果がすでに起きた）、steering の依頼（承認した時点で効果が始まる）。
  - 監査: 監査台帳（`approval_decision` / `revoke`）と、その channel のイベントログ（`revoked`、消費は
    `consumed`）。
- **ON・利用時**: 承認済みレコードを効果に変える箇所は、次の consumer id で同じ判定をやり直す
  （`assertApprovalUsable` / `approvalUsabilityRefusal`、拒否は `use:<consumer id>` として監査）。OFF のときに
  記録された自己承認などは、ON にした後では効果にならない。一覧は
  `libs/core/governance/approval-sod-consumers.contract.test.ts` と一致させる。
  - 承認ゲートと store: `approval_gate`、`approval_gate_session_cache`、`apply_claim`
  - DOT: `dot_release`、`dot_dispatch`、`dot_autonomy_promotion`（拒否時は昇格待ちを監査付きで取り消す）、
    `front_desk_execution`
  - mission と discussion: `mission_scope_approve`、`mission_reconcile_work`、`discussion_mission`
  - plugin と MCP: `plugin_view_action`、`plugin_activation`（plugin の有効化判定。監査なしで判定し、
    使えない承認は `pending_approval` にする）、`mcp_governed_tool`
  - pipeline: `pipeline_await_decision`、`pipeline_bound_approval`
  - その他の効果: `project_trust`、`secret_introduction`、`background_review_patch`、`peer_runtime_recovery`、
    `marketing_publication`、`held_action_apply`（held action は取り消され、依存する held action も取り消される。
    drain は他の held action を続ける）、`agent_prompt_approval`、`system_actuator_computer`、
    `approval_actuator_request_review`
  - script: `audit_mirror_reconcile`、`entity_governance_cleanup`、`mission_alignment_gate`、
    `organization_decision`、`org_security_policy_write`（`scripts/org.ts`）、`personal_workbench`
  - service recording: `service_recording_review`（`scripts/service_recording.ts` の review が承認を
    recording に書く前）、`service_recording_promotion`（promotion が review の承認を確かめる。
    `libs/core/service/service-recording-review-approval.ts`）
- **利用できない承認の扱い**: 利用時の拒否メッセージは「この承認は再利用されない。新しい承認を依頼し、
  別の、サーバーが識別した principal に決定してもらう」と、分かる場合は再依頼の正確なコマンドを示す
  （held action の場合は held action 自体を依頼し直すよう示す）。承認済みで claim も適用もされていないレコードなら、
  以後の利用を止めるコマンド（`pnpm kyberion approvals --revoke <id>`）も示す。再依頼の入口（`enforceApprovalGate`、provider attestation の `--request-approval`、
  approval-actuator の `request_review`、mission の scope-approve と reconcile-work、project trust、
  background review、agent prompt）は、利用できない承認済みレコードを返さず、新しい依頼を開く。
  承認ゲートは、使える候補が残っていないときだけ（新しい依頼を開くときに）1 回監査する。
- 却下（`rejected`）は対象外。依頼者が自分の依頼を却下するのは取り下げにすぎない。
- **比較する identity**: 依頼側は `requestedBy`、`requestedByContext.actorId`、`source.agentId` のすべて。
  決定側は `decidedBy`（staged workflow では承認済みの各 stage の `approvedBy` も）。どちらも NFKC 正規化・
  前後空白除去・小文字化し、principal 種別の接頭辞（`user:` `human:` `operator:` `member:` `principal:`
  `agent:` `service:` `persona:` `actor:` `policy:`）を外してから比較する。`user:alice` と `alice` は同じ principal。
- **policy ファイルが無いとき・壊れているとき**: 承認の決定と、承認済みレコードの利用は、まず
  `approval-policy.json` を読んで SoD の設定を確かめる。
  - ファイルが無い（customer overlay も product 既定も無い。例: knowledge を持たない作業用 root）ときは、
    出荷時の既定（`separation_of_duties.enabled: false`）として扱い、debug ログを 1 行出す。既定は OFF なので、
    これで新しく許されることは無く、SoD OFF の振る舞いは変わらない。
  - ファイルはあるが読めない・schema に合わないときは、SoD を OFF にしているつもりでも、承認の決定と利用は
    `[POLICY_VIOLATION] approval decision blocked — approval-policy.json unreadable | next: fix <path> | evidence: <原因>`
    で止まる（fail closed）。却下は policy を読まないので通る。plugin の有効化判定だけは、例外を投げずに
    `pending_approval` に落とし、診断の警告をログに出す（plugin 一覧や読み込みが止まらないように）。
    DOT autonomy の昇格待ちは取り消さず、次の sweep で再試行する。
- **スコープ**: 設定は `approval-policy.json` 全体と同じく、有効な customer overlay
  （`customer/<slug>/policy/approval-policy.json`）がある場合はそれが product 既定を丸ごと置き換える。
  tenant・organization 単位の上書きはない（global 設定）。

### 限界

- **文字列 identity の一致で判定する。** 次の場合、同じ人でも検出できない（false negative）。
  - 同じ人を別の文字列で表す場合: メールアドレスと member id など。CLI と script、mission brief ページ、
    chronos の loopback は同じ `user:<member_id>` を記録するので、端末どうし・端末と chronos の間では
    検出できる。owner member の無い端末で OFF のときに記録した値（persona、表示名）は対象外。
  - NFKC で同一化されない見た目の似た文字（例: ラテン文字の `a` とキリル文字の `а`）。
  - 依頼を作った人間ではなく component 名を依頼者として記録する作成元
    （`<surface>_surface_steering`、`system-actuator`、`pipeline:<runId>` など）。
- **端末の判定は best effort で、セキュリティ境界ではない。** 端末は操作している人を認証できない。
  - agent のセッションの目印（`KYBERION_AGENT_ID` など、provider CLI の `CLAUDECODE` など）は参考情報に
    すぎない環境変数で、agent は消せる（`env -u CLAUDECODE …`）。目印の無い agent の依頼は owner として
    記録され、人の承認は自己承認として拒否される（拒否側）。人が agent のセッションのシェルに打った依頼は
    agent の依頼として記録され、本人の承認が通る（false negative）。
  - ON の TTY チャレンジは、目印を消した agent が非対話で `--approve` するのを止めるが、PTY を操作できる
    agent（例: terminal-actuator 経由）は表示されたコードを読んで入力できる。
  - 依頼者と別の人の承認を agent に対して確実にするには、認証済みの surface（Chronos か presence-studio。
    検証済みのセッションから `user:<member_id>` を記録する）で承認する。これが強い経路である。
- **service recording の review の依頼者。** review の依頼は `capture`（または `request-review`）を
  実行した principal が開く。依頼の無い recording を `review` すると、その場で review する人を依頼者として
  依頼を開くので、ON では本人の承認が拒否され、別の principal の承認が必要になる: 別の member が認証済みの
  surface（Chronos か presence-studio）で決定するか、他の人が開いた依頼なら対話的な端末で
  `service_recording review --approve` を実行してチャレンジに答える。依頼より前に書かれた review
  （`approval_request_id` が無い）は、ON では promotion で拒否され、拒否メッセージは同じ手順を示す。
- **依頼者が値を決められる誤一致（false positive）。** `requestedBy` などは依頼側が書くので、依頼者が承認者の
  identity を名乗ると、その承認者の承認が拒否される。拒否側に倒れるだけで承認が不正に通ることはないが、
  承認の妨害には使える。
- **policy / service の決定者は別 principal として扱う。** veto window の自動決定（`policy:veto-window`）や
  secret introduction の自動承認（`policy:secret-introduction-local-low-risk`）は人の名前ではないが、
  代替値の一覧には入れていないので、依頼者と文字列が違えば「別の principal」とみなされ承認が通る。
  これらの自動決定を SoD の対象にするかは、それぞれの policy（veto window、secret introduction の自動承認条件）で決める。
- **対象外の承認経路。** approval-store を通らない独自の承認は設定の対象外（`service_recording review`
  は store を通るようにした）。
- 確実に分離するには、承認を依頼者とは別の認証済み member（chronos / presence-studio の `user:<member_id>`）が行う。
