# Travel Planning Playbook

Use this playbook when a user asks for a trip plan, tour comparison, reservation path, or anniversary itinerary.
It specializes the shared [Guided Coordination Protocol](knowledge/public/orchestration/guided-coordination-protocol.md) for travel and reservation work.

## Kyberion Fit

Travel planning should not be handled as a one-shot search answer when the user expects Kyberion-level value.
Treat it as a guided coordination workflow:

1. Capture the user's initial request as travel intent.
2. Ask only the questions that change planning or booking decisions.
3. Convert answers into a `travel-planning-brief`.
4. Attach a `booking-preference-profile` for points portals, booking sites, login methods, payment policy, and receipt handling.
5. Produce a decision-ready itinerary and booking recommendation.
6. Stop before login, reservation, cancellation, profile mutation, or payment unless explicit approval is granted.

The intended user-facing posture is "travel coordinator", not "hotel search bot".

## Site Selection Preflight

Before the full candidate search, decide which site group should be used for this run.

Use this lightweight preflight when current sales, campaign pages, points rates, or login friction may change the best choice.

1. Read the stored `booking-preference-profile`.
2. Check current sale or campaign signals only when the profile says to compare them before deciding, or when the category is new.
3. Compare the current run against the user's usual favorites and backup sites.
4. Ask a short tie-breaker question only if the decision is still ambiguous.
5. Record the selected site group and proceed to search, comparison, and booking recommendation.

Keep this preflight short. It should decide the site set for the run, not replace the trip brief.

The same pattern works for restaurant booking, activity tickets, and packaged experiences inside the trip. Travel planning does not need a separate rule if the booking site choice changes because of a sale, points campaign, or loyalty path.

If the profile includes `preflight_question_sets`, use the travel-specific pack first. Keep the first questions to the ones that change the site group or the hotel shortlist, then expand only if the choice is still ambiguous.

## Planning

1. Normalize the request into a `travel-planning-brief`.
2. Separate personal facts from public travel facts.
3. Require explicit approval for login, reservation, cancellation, profile mutation, and payment execution.
4. Use a `booking-preference-profile` reference for booking sites, login methods, payment policy, and points portal routing.
5. Use `site_selection_policy` when current sales or campaign differences should influence which site group is used for this run.
6. If `preflight_question_sets` is present, start with the matching travel pack before falling back to the universal intake list.

## Intake And Hearing

Start with a short intake packet. Do not ask every possible travel question at once; ask the smallest set that affects candidate selection.

Required intake:

1. Travelers: number of adults, children, relationship context, accessibility constraints.
2. Dates: check-in, check-out, fixed arrival/departure times, flight numbers if already booked.
3. Destination scope: city, island, area preference, acceptable travel radius.
4. Trip goal: relaxation, sightseeing, food, anniversary, family convenience, workation, budget optimization.
5. Budget: total lodging budget, nightly ceiling, tolerance for taxes/fees/resort fees.
6. Mobility: rental car, taxi, public transport, walking tolerance, luggage constraints.
7. Hotel preferences: beach, pool, room size, breakfast, bath, view, cancellation flexibility, brand loyalty.
8. Avoid list: crowded areas, long drives, smoking rooms, nonrefundable plans, dated facilities.
9. Booking policy: preferred booking sites, points portal, coupon priority, payment method, receipt needs.
10. Output expectation: ranked hotels only, full itinerary, booking comparison, approval-ready reservation packet, travel booklet.

Default assumptions are allowed only for non-blocking fields and must be stated in the brief. Blocking unknowns should be returned as clarification questions in an operator-facing packet before execution.

For a request like "I will go to Okinawa from 2026-06-06 to 2026-06-08. Find recommended hotels", the first Kyberion response should ask for decision-changing inputs such as:

1. Number of travelers and room count.
2. Total lodging budget or nightly ceiling.
3. Area preference: Naha, Chatan, Onna, Motobu, or "optimize for the plan".
4. Rental car availability.
5. Booking preference: Rakuten Travel, Jalan, Booking.com, official site, points portal route, or "compare and recommend".

If the user wants Kyberion to proceed without answers, use conservative defaults: two adults, one room, Okinawa main island, no confirmed rental car, free-cancellation preferred, no booking/payment execution.

## Team Shape

Use a small team model only when the work goes beyond a direct answer.

Recommended roles:

1. Travel Coordinator: owns the conversation, asks clarifying questions, turns preferences into a `travel-planning-brief`, and produces the final itinerary.
2. Hotel Scout: searches lodging candidates, captures current prices, cancellation terms, access, and source timestamps.
3. Route Planner: validates area fit, airport transfers, rental-car assumptions, and day-by-day movement.
4. Booking Optimizer: compares booking sites, points portal routes, coupons, payment policy, and receipt requirements through `booking-preference-profile`.
5. Risk Reviewer: checks weather seasonality, closure risk, cancellation risk, children/accessibility constraints, and backup plans.

One owner still controls the mission. Supporting roles contribute findings through task contracts or artifacts; they do not mutate mission state directly.

## Kyberion Workflow

Use this progression:

1. Intent capture: preserve the original user request and extract known facts.
2. Clarification pass: ask up to two or three blocking questions per turn.
3. Brief draft: create a draft `travel-planning-brief` with assumptions and missing fields.
4. Preflight: validate the brief and booking profile against schemas.
5. Site selection preflight: compare current sales, campaigns, and login friction against the profile, then ask only the tie-breaker questions that change site-group choice.
6. Research: gather hotels, activities, transport, and dynamic facts with source timestamps.
7. Candidate scoring: rank options by fit, cost, convenience, resilience, cancellation flexibility, and uniqueness.
8. Decision packet: show recommended hotel, runner-up, booking path, points route, approval gates, and fallback.
9. Itinerary artifact: generate a travel booklet with schedule, maps/transfer notes, booking checklist, weather backup, restaurants, and emergency references.
10. Approval boundary: pause for explicit approval before login, points portal redirect, reservation hold, payment, cancellation, or personal data storage.
11. Review: distill reusable preferences into personal knowledge only when the user approves storage.

## Review

1. Check date, destination, traveler, occasion, pace, and budget assumptions.
2. Identify missing inputs that materially affect the plan.
3. If sales, coupons, or points are likely to change the decision, run the site selection preflight before the full comparison.
4. Prefer official or primary sources for weather, closures, opening hours, event dates, and booking terms.
5. Reject candidates that are closed, date-incompatible, or weather-sensitive without a backup.

## Execution

1. Compile the brief and profile into an ADF pipeline only after the brief passes review.
2. Capture dynamic facts with timestamps and source references.
3. Score candidates on fit, resilience, travel efficiency, uniqueness, and cost.
4. Preserve a fallback path when points portal tracking, login, coupon, or cancellation terms are uncertain.
5. When the preflight reveals a meaningful sale or campaign split, surface that decision explicitly in the booking packet.

## Outputs

A Kyberion travel coordination result should include more than "recommended hotels".

Minimum output:

1. Current assumptions and unanswered blocking questions.
2. Ranked hotel candidates with reasons, tradeoffs, source timestamps, and cancellation notes.
3. Booking path recommendation: booking site, points portal route, payment policy, and approval boundary.
4. Day-by-day itinerary draft with travel time assumptions.
5. Backup plan for weather, closures, fatigue, or transport failure.

Full output:

1. Approval-ready booking packet.
2. Travel booklet in Markdown or deck format.
3. Expense and receipt checklist.
4. Personal preference update proposal for future trips.

## Testing

1. Validate the brief and booking profile against their JSON schemas.
2. Test that inline secrets are rejected.
3. Test that payment execution remains approval-gated.
4. Test that points portal routing requires evidence and fallback rules.
