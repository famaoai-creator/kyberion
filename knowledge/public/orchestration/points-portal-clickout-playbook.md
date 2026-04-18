# Points Portal Clickout Playbook

Use this playbook when the task is to start from a points portal and land on a merchant site before booking.

## Planning

1. Resolve the user's booking preference profile.
2. Select the points portal and merchant from `points_portal_policy.routing_rules`.
3. Draft a `points-portal-clickout-usecase` contract.
4. Keep credential, payment method, cookies, and session state as references only.

## Review

1. Confirm the portal advertiser page, reward terms, and merchant target.
2. Confirm the clickout selector or operator-visible button text.
3. Confirm landing match rules such as `url_includes` and `title_includes`.
4. Confirm blocked actions include reservation confirmation, payment execution, and session handoff export.

## Execution

1. Run preflight before generating executable browser ADF.
2. Use a dedicated browser profile when authenticated state is needed.
3. Capture portal detail, tabs before clickout, tabs after landing, merchant landing screenshot, and network evidence.
4. Do not export cookies, storage, session handoff artifacts, credentials, or payment details.
5. Stop after merchant landing evidence unless a separate booking contract is approved.

## Testing

1. Validate the use-case contract against `points-portal-clickout-usecase.schema.json`.
2. Assert generated browser ADF does not contain `export_session_handoff`.
3. Assert generated browser ADF contains `select_tab_matching` or an equivalent landing selection step.
4. Assert success criteria match the target merchant domain before marking the route successful.
