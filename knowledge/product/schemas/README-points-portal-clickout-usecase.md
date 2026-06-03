# Points Portal Clickout Use Case

`points-portal-clickout-usecase.schema.json` defines the reusable contract for routing from a points portal to a merchant site.

Use it when a user says something like:

- Moppy 経由で楽天トラベルを開きたい
- Hapitas 経由で一休を比較したい
- ポイントサイト経由予約の導線だけ先に検証したい

The contract is intentionally higher level than browser-actuator ADF. It records the business intent, safety gates, evidence requirements, and success criteria. A governed compiler or operator then turns it into executable browser ADF.

Required safety properties:

- `payment_execution` and `reservation_confirmation` must be blocked.
- `session_handoff_export` must be blocked.
- `artifact_policy.forbid_session_handoff_export` must be `true`.
- `preflight.deny_ops` must include `export_session_handoff`.
- Authenticated state must be referenced by browser profile or account references, never by cookies, passwords, card numbers, or one-time codes.

This separates reusable user preference from one-off execution:

- `booking-preference-profile`: which portals, merchants, login methods, and payment policy the user prefers.
- `points-portal-clickout-usecase`: one governed route from portal advertiser page to merchant landing page.
- Browser ADF: the concrete actuator execution generated after preflight passes.
