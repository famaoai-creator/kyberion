# Booking Preference Profile

`booking-preference-profile.schema.json` stores reusable booking preferences separately from travel-planning ADF.

It can express:

- preferred booking sites
- login method preferences
- payment policy
- points portal routing
- receipt preferences
- required approval gates

Secrets must be represented by references such as `secret://wallet/main-card` or `browser://profile/site-login`. Never embed raw credentials, card numbers, CVV values, one-time codes, or session cookies.

For points-portal routes, `points_portal_policy.routing_rules[].clickout_usecase_ref` may point to a governed `points-portal-clickout-usecase` contract. Store the preference here, but execute only after the use-case contract passes preflight.
