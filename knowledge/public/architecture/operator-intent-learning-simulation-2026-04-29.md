---
title: Operator Intent Learning Simulation
category: Architecture
tags: [intent, operator-learning, simulation, personal-memory, ceo, cto]
importance: 9
author: Codex
audit_date: 2026-04-29
last_updated: 2026-04-29
---

# Operator Intent Learning Simulation

## 1. Purpose

This document captures a simulation-driven approach for adapting Kyberion to a
specific human operator who acts as both CEO and CTO.

The goal is not only to answer single requests, but to learn the operator's:

- preferred phrasing
- approval thresholds
- decision style
- recurring request families
- terminology
- preferred output shapes

The operating principle is:

`request -> normalize -> decide -> execute -> verify -> distill -> promote -> reuse`

The simulation should be repeated many times across CEO-like, CTO-like, and
hybrid requests so that Kyberion can accumulate reusable operator knowledge
without flattening every interaction into a generic chat loop.

## 2. Simulation Frame

Use three layers when simulating:

- **Operator layer**
  - who is asking
  - what role they are speaking from
  - what decision they are trying to make
- **Intent layer**
  - how the request normalizes
  - whether it is clarification, execution, summary, escalation, or analysis
- **Memory layer**
  - whether the result should stay personal, become confidential, or be promoted

In practice, the simulation can be split into two roles:

- a simulated requester who speaks like the operator
- Kyberion, which responds, clarifies, executes, and distills learning

## 3. CEO Request Families

These are the most likely CEO-style request families.

| Family | Example request | What Kyberion should do | Expected outcome |
|---|---|---|---|
| Strategy | `今期の成長戦略を3案で比較して、最も現実的な案を提案して` | clarify goals and constraints, compare options, recommend one path | strategy memo, tradeoff table, risks |
| Prioritization | `次の四半期にやることを5つに絞って、やらないことも決めて` | rank work, show exclusions, tie to business goals | prioritized roadmap |
| Hiring | `営業責任者候補の採用方針と面接評価軸を作って` | define role, evaluation axes, interview process | hiring rubric, interview sheet |
| Finance | `来月の資金繰りと投資余地を確認したい` | normalize cash flow, scenarios, and limits | cash forecast, investment room |
| Executive reporting | `今月の経営会議向けにKPIサマリを1枚でまとめて` | reduce to decision-ready summary | executive one-pager |
| Stakeholder comms | `役員会向けに社員向けメッセージのたたき台を作って` | draft message, anticipate objections, align tone | communication draft |
| Decision support | `A案とB案の投資判断を、前提・リスク・撤退条件込みで比較して` | compare options with decision criteria | decision memo |
| Sales/account strategy | `大口顧客のアップセル戦略を整理して、提案の切り口を出して` | map account context and propose sales story | account plan |
| Org/process | `組織の役割が重複しているので、責任分界と会議体を見直したい` | analyze role overlap, process, meetings | org/process redesign |
| Risk/governance | `監査指摘が出そうな領域を洗い出して優先順位を付けて` | classify risk and remediation order | risk register |
| Customer escalation | `解約しそうな顧客への対応方針を考えて` | identify issue, constraints, and response path | retention plan |
| Crisis response | `障害対応の対外説明と再発防止策をまとめて` | separate facts, explanation, prevention | incident statement |

### CEO signal to watch

- repeated use of comparison language
- preference for short decision memos
- high sensitivity to approval boundaries
- frequent need for "what to do next" rather than raw detail

## 4. CTO Request Families

These are the most likely CTO-style request families.

| Family | Example request | What Kyberion should do | Expected outcome |
|---|---|---|---|
| Architecture review | `このモノリスを 3 つの分割案で比較して。運用コストと移行リスクも出して` | compare architecture options with tradeoffs | architecture memo |
| Hotfix / refactor | `本番バグを最小差分で直して、回帰テストも回して` | reproduce, patch, validate, summarize | patch + test results |
| Incident triage | `本番で 5xx が増えている。切り分けて初動案を出して` | isolate impact, propose containment | incident response plan |
| Observability patrol | `Datadog/Grafana で異常がないか巡回して、要点だけまとめて` | inspect metrics and summarize anomalies | monitoring summary |
| CI/CD triage | `CI が落ちた。原因を特定して、再発防止まで整理して` | inspect pipeline failures and root cause | triage report |
| Workspace bootstrap | `新メンバーの開発環境を macOS 前提で一式そろえて` | setup dependencies and confirm readiness | bootstrap checklist |
| LLM/provider selection | `OpenAI / Anthropic / Gemini のどれを使うべきか、コストと品質で比較して` | compare provider capabilities and cost | provider recommendation |
| Runtime tuning | `エージェントの起動数とメモリ上限を調整して、遅延を半分にして` | propose tuning and measure impact | tuning report |
| Governance of risky change | `この危険な設定変更の承認フローを作って、監査証跡も残して` | design approval gates and evidence | approval workflow |
| Knowledge retrieval | `過去の障害対応メモを探して、今回に使える手順だけ抜き出して` | search, summarize, and reuse knowledge | distilled runbook |
| Technical decision memo | `この投資判断の技術面を整理して、採用可否を 1 枚でまとめて` | compare choices and write a decision memo | decision memo |
| Release readiness | `明日のデプロイを go / no-go 判定して、条件付きなら条件も出して` | compile readiness checks and determine status | go/no-go report |
| Secret rotation | `期限切れのシークレットを洗い出して、ローテーション計画を作って` | identify credentials and plan rotation | rotation plan |
| ADR sync | `この決定を ADR にして、関係者向けの要約も作って` | turn decisions into durable records | ADR + summary |

### CTO signal to watch

- request for comparison, benchmarking, or proof
- preference for operationally safe outputs
- strong need for explicit rollback or escalation conditions
- sensitivity to provider/model choice and runtime cost

## 5. Human-Like Learning Loop

The operator-specific learning process should be normalized as a repeated loop.

1. Capture the raw request.
2. Normalize it into an intent family.
3. Match it against the operator profile.
4. Clarify only the missing details that change the outcome.
5. Execute the governed path.
6. Verify whether the result matched the operator's expectation.
7. Distill stable preference signals.
8. Promote only reusable patterns.
9. Reuse the promoted pattern in future routing.

### What to learn

- preferred language and tone
- desired output shape
- approval threshold
- typical decision depth
- recurring request families
- preferred terminology
- risk sensitivity
- when to ask questions versus when to proceed

### What not to learn into the wrong tier

- raw secrets
- customer-specific data
- one-off strategy details
- unredacted transcripts
- anything that should remain mission-local

## 6. Tiering Rules

| Tier | Store here | Example |
|---|---|---|
| Personal | private preferences, style, wording, approval habits, correction history | `knowledge/personal/operator-profile.json` |
| Confidential | company-specific operating norms, internal thresholds, customer strategy | `knowledge/confidential/...` |
| Public | generic schema, reusable learning loop, sanitized examples | `knowledge/public/...` |

The important distinction is:

- **personal**: how this operator likes to work
- **confidential**: how this organization works
- **public**: what can be reused generically

## 7. Suggested Profile Shape

```jsonc
{
  "profile_id": "ceo-cto-hybrid",
  "roles": ["ceo", "cto"],
  "locale": "ja-JP",
  "communication": {
    "preferred_language": "ja",
    "response_style": "brief_direct",
    "preferred_detail_level": "compact",
    "question_budget_default": 1
  },
  "decision_style": {
    "ambiguity_tolerance": "medium",
    "prefers_options_over_open_ended": true,
    "default_assumption_policy": "reasonable_and_explicit",
    "ask_before_action_if": [
      "irreversible_action",
      "high_risk_action",
      "financial_commitment",
      "external_side_effect",
      "authority_unclear"
    ]
  },
  "terminology": {
    "canonical_terms": [
      { "term": "mission", "aliases": ["task", "案件"] },
      { "term": "execution brief", "aliases": ["request understanding"] }
    ]
  },
  "recurring_tasks": [
    {
      "family": "decision_support",
      "trigger_phrases": ["比較して", "論点整理", "どう思う"]
    },
    {
      "family": "reporting",
      "trigger_phrases": ["経営レポート", "1枚でまとめて"]
    }
  ],
  "learning": {
    "update_policy": "incremental",
    "min_samples_to_promote": 5,
    "retain_counterexamples": true,
    "drift_detection": true
  }
}
```

## 8. Suggested Request Log Shape

```jsonc
{
  "request_id": "req_2026_04_29_0001",
  "profile_id": "ceo-cto-hybrid",
  "surface": "terminal",
  "raw_request": "Adapt Kyberion to me as a CEO/CTO hybrid.",
  "normalized_intent": {
    "intent_id": "operator_learning",
    "task_family": "operator_profile_learning"
  },
  "route": {
    "shape": "direct_reply",
    "confidence": 0.93
  },
  "signals": {
    "decision_style_observed": "executive_shortform",
    "terminology_observed": ["profile", "schema", "request log"],
    "approval_threshold_observed": ["no file edits", "return schema only"]
  },
  "verification": {
    "result": "satisfied",
    "operator_correction_count": 0
  },
  "learning_update": {
    "candidate_created": true,
    "candidate_kind": "operator-preference-card",
    "promote_eligible": true
  },
  "privacy": {
    "tier": "personal",
    "contains_sensitive_info": false
  }
}
```

## 9. Recommended Training Sequence

1. Start with 10 to 20 simulated requests.
2. Include both CEO-like and CTO-like prompts.
3. Force clarification whenever the outcome depends on missing constraints.
4. Record the operator's correction pattern.
5. Promote only the signals that repeat.
6. Keep the rest as raw personal evidence.

This makes Kyberion adapt to the operator without collapsing everything into a
single generic assistant memory.

## 10. Implemented Harness Contracts

The simulation is now backed by first-class surface intents:

| Intent | Role signal | Outcome |
|---|---|---|
| `executive-strategy-brief` | CEO strategy comparison | `strategy_brief` |
| `executive-prioritization` | CEO focus and tradeoff selection | `priority_roadmap` |
| `executive-reporting` | CEO reporting and KPI summary | `executive_report` |
| `stakeholder-communication` | CEO stakeholder messaging | `stakeholder_message` |
| `sales-account-strategy` | CEO customer/account strategy | `account_strategy_plan` |
| `technical-decision-memo` | CTO decision memo | `technical_decision_memo` |
| `llm-provider-selection` | CTO provider/model choice | `provider_selection_report` |
| `agent-runtime-tuning` | CTO runtime optimization | `runtime_tuning_plan` |
| `release-readiness-review` | CTO go/no-go judgment | `release_readiness_report` |
| `operator-profile-learning` | personal adaptation loop | `operator_learning_update` |

Two schemas anchor the learning layer:

- [`operator-profile.schema.json`](../schemas/operator-profile.schema.json)
- [`operator-request-log.schema.json`](../schemas/operator-request-log.schema.json)
- [`operator-learning-scenario-pack.json`](../governance/operator-learning-scenario-pack.json)
- [`operator-learning-dispatch-registry.json`](../governance/operator-learning-dispatch-registry.json)

The runtime helper is:

- [`operator-learning.ts`](/Users/famao/kyberion/libs/core/operator-learning.ts)

It validates profile and request-log records, can create an
`operator-request-log` from an `intent_resolution_packet`, builds an
approval-gated `operator-learning-proposal`, can simulate repeated utterances
into request logs plus a proposal, and can promote an approved proposal into a
promotion record. Promotion is explicit:

- below-threshold learning proposals are blocked by default
- `approvedBy` is required
- the target tier and path are recorded
- personal adaptation is written only through an explicit promotion call
- the scenario pack includes golden, ambiguous, approval-sensitive, and
  controlled-failure cases for CEO/CTO-style requests
- conversation orchestration is included as a first-class human-LLM learning
  case, not just a transport-layer detail
- approval workflow requests and resolution are included as explicit
  `task_session` cases, so the harness learns when to stay in governed ops
- knowledge lookup and browser navigation are included as explicit learning
  cases, so the harness does not collapse search or browsing into generic chat
- learning signals are dispatched through a governed registry, so new intent
  patterns can be added by knowledge updates instead of code edits
- registry overlays can be layered by tier, so personal or confidential
  additions override public defaults without changing code

These contracts make the harness concrete: simulated requests can now resolve
to named intents, produce named outcomes, emit validated learning records from
the conversation entry point, batch-test recurring CEO/CTO request patterns,
and avoid silently mutating personal knowledge.
