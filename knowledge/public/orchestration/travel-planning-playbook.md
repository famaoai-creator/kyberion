# Travel Planning Playbook

Use this playbook when a user asks for a trip plan, tour comparison, reservation path, or anniversary itinerary.

## Planning

1. Normalize the request into a `travel-planning-brief`.
2. Separate personal facts from public travel facts.
3. Require explicit approval for login, reservation, cancellation, profile mutation, and payment execution.
4. Use a `booking-preference-profile` reference for booking sites, login methods, payment policy, and points portal routing.

## Review

1. Check date, destination, traveler, occasion, pace, and budget assumptions.
2. Identify missing inputs that materially affect the plan.
3. Prefer official or primary sources for weather, closures, opening hours, event dates, and booking terms.
4. Reject candidates that are closed, date-incompatible, or weather-sensitive without a backup.

## Execution

1. Compile the brief and profile into an ADF pipeline only after the brief passes review.
2. Capture dynamic facts with timestamps and source references.
3. Score candidates on fit, resilience, travel efficiency, uniqueness, and cost.
4. Preserve a fallback path when points portal tracking, login, coupon, or cancellation terms are uncertain.

## Testing

1. Validate the brief and booking profile against their JSON schemas.
2. Test that inline secrets are rejected.
3. Test that payment execution remains approval-gated.
4. Test that points portal routing requires evidence and fallback rules.
