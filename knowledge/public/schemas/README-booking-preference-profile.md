# Booking Preference Profile

`booking-preference-profile.schema.json` stores reusable booking preferences separately from travel-planning ADF.

It can express:

- preferred booking sites
- login method preferences
- payment policy
- per-request site selection preflight
- category-specific preflight question sets
- points portal routing
- receipt preferences
- required approval gates

Secrets must be represented by references such as `secret://wallet/main-card` or `browser://profile/site-login`. Never embed raw credentials, card numbers, CVV values, one-time codes, or session cookies.

`site_selection_policy` is the bridge between stable preferences and a one-off trip or reservation decision. Use it to decide when Kyberion should check current sales, compare candidate site groups, and ask the user for a tie-breaker before choosing the site set for this run.

The example profile shows how to split that logic by category: travel, restaurant, activity/tickets, family planning, shopping, medical scheduling, subscriptions, and home services can each have different default site sets, fallback sites, and sale thresholds.
Family and gifts can use the same pattern when the first questions are about coordination, delivery timing, or approval boundaries rather than pure price comparison.

`preflight_question_sets` lets Kyberion choose the first 1-3 hearing questions from the same profile. Keep the set short and category-specific so the system can ask only the blockers that matter for that booking class.

For points-portal routes, `points_portal_policy.routing_rules[].clickout_usecase_ref` may point to a governed `points-portal-clickout-usecase` contract. Store the preference here, but execute only after the use-case contract passes preflight.
