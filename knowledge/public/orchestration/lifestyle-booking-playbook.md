# Lifestyle Booking Playbook

Use this playbook when the user asks Kyberion to schedule, reserve, purchase, renew, cancel, or coordinate personal-life services.
It specializes the shared [Guided Coordination Protocol](./guided-coordination-protocol.md) for booking and personal coordination work.

Examples:

- restaurant reservations
- salon, clinic, dental, and wellness appointments
- gifts and anniversary arrangements
- shopping, daily supplies, and hometown-tax donations
- tickets, events, and activities
- home services, repairs, deliveries, and redelivery
- family and child-related scheduling
- subscription renewal, downgrade, and cancellation

## Kyberion Fit

Lifestyle booking work should be handled as a coordination flow, not a direct answer.
The value is in hearing, constraint capture, calendar fit, candidate comparison, approval gating, and reusable preference memory.

Use Kyberion when the task has at least one of these properties:

1. It touches a booking, purchase, cancellation, payment, login, or profile change.
2. It depends on personal preferences, calendar availability, family context, or past history.
3. It benefits from comparing options across services or points routes.
4. It should produce a calendar event, checklist, reservation packet, or reminder.
5. It should be repeatable later with updated availability or prices.

For one-shot public information requests, answer directly and do not create a mission.

## Site Selection Preflight

Before searching the final candidates, decide which site group should be used for this run.

Use this lightweight preflight when current sales, campaign pages, points rates, or login friction may change the best choice.

1. Read the stored `booking-preference-profile`.
2. Check current sale or campaign signals only when the profile says to compare them before deciding, or when the category is new.
3. Compare the current run against the user's usual favorites and backup sites.
4. Ask a short tie-breaker question only if the decision is still ambiguous.
5. Record the selected site group and proceed to search, comparison, and booking recommendation.

Keep this preflight short. It should decide the site set for the run, not replace the service brief.

Good fits for this preflight include restaurants, activities, tickets, gifts, shopping, medical scheduling, subscriptions, and home services. The site set may be different for each category, but the decision rule is the same: compare the live sale signal against the user's preferred defaults, then only ask when the choice is not obvious.

If the profile includes `preflight_question_sets`, use the matching category pack to ask the first 1-3 questions. Keep those questions focused on the site group choice or the highest-risk booking constraint.

For medical tasks, keep the preflight limited to scheduling logistics and privacy-preserving routing. Do not use it to infer symptoms, treatment, or anything beyond reservation handling.

For subscriptions, the same preflight should compare renewal path, cancel flow, downgrade terms, and whether the official account center is safer than a third-party app.

For home services, the preflight should compare availability, access constraints, estimate terms, and whether the provider has a clearer booking path than the marketplace.

## Intake And Hearing

Ask only decision-changing questions first. Avoid making the user fill out a full form.

Universal intake:

1. Goal: what outcome the user wants and by when.
2. Participants: who is involved, headcount, age/accessibility constraints, relationship context.
3. Time window: preferred date/time, hard deadlines, calendar conflicts, reminder needs.
4. Location: area, travel radius, transport mode, parking needs, delivery address reference.
5. Budget: ceiling, price sensitivity, coupon/points preference, payment policy.
6. Preference: must-have, nice-to-have, avoid list, previous favorites, disliked vendors.
7. Account path: preferred service, login method, points portal, receipt and invoice needs.
8. Approval boundary: what Kyberion may do without approval and where it must stop.
9. Site selection: whether to compare sales or campaigns first, or stick with the preferred sites unless the difference is material.

Category-specific additions:

1. Restaurant: cuisine, dietary restrictions, occasion, private room, smoking policy, course vs a la carte.
2. Salon/wellness: menu, staff preference, previous treatment, contraindications, aftercare schedule.
3. Medical: existing provider, symptoms only if needed for booking category, insurance/card references, privacy constraints.
4. Gifts: recipient, occasion, delivery date, past gifts, message card, address reference.
5. Shopping: inventory assumption, brand preference, quantity, delivery window, return policy.
6. Tickets/events: seating, companion availability, lottery or fixed-sale timing, cancellation/refund terms.
7. Home services: photos/model numbers, entry constraints, parking, building rules, onsite estimate tolerance.
8. Family/children: guardians, pickup/dropoff, school deadlines, consent forms, belongings.
9. Subscriptions: renewal date, actual usage, alternatives, export-before-cancel requirements.

If the user asks Kyberion to proceed with missing answers, record the assumptions and keep risky actions gated.

## Team Shape

Use a small role set for multi-step lifestyle work:

1. Lifestyle Coordinator: owns the conversation, asks hearing questions, and maintains the operator-facing plan.
2. Availability Scout: checks open slots, prices, service menus, stock, event dates, and dynamic facts.
3. Preference Steward: applies prior preferences and proposes personal-memory updates only with approval.
4. Booking Optimizer: compares vendors, points portals, coupons, cancellation terms, and receipt needs.
5. Risk Reviewer: checks privacy, medical sensitivity, cancellation penalties, nonrefundable terms, and family constraints.

The owner agent remains singular. Supporting roles should return findings as artifacts or task contracts.

## Workflow

1. Intent capture: preserve the original request and known facts.
2. Clarification pass: ask up to two or three blocking questions per turn.
3. Planning packet: summarize assumptions, candidate sources, approval gates, and intended output.
4. Research: collect availability, prices, terms, and source timestamps.
5. Site selection preflight: compare sales, campaigns, and login friction against the profile, then ask only the tie-breaker questions that change site-group choice.
6. If `preflight_question_sets` is present, pick the category pack and ask only the first questions that materially change the run.
7. Compare: rank candidates by fit, time, cost, resilience, cancellation flexibility, and preference match.
8. Preview: present the recommended action and alternatives before any external side effect.
9. Approval: pause before login, booking confirmation, purchase, payment, cancellation, profile mutation, or personal data storage.
10. Execute: proceed only through approved ADF or browser/service actuator steps.
11. Record: create calendar events, reminders, checklists, receipts, and evidence snapshots as requested.
12. Review: propose reusable preference updates for `knowledge/personal/` only when the user approves.

## Approval Boundaries

Always require explicit approval for:

1. Credential use or account login.
2. Points portal redirect or affiliate clickout.
3. Reservation hold or booking confirmation.
4. Purchase, payment, or payment method selection.
5. Cancellation, downgrade, refund request, or contract change.
6. Sending personal information to an external service.
7. Storing or updating personal preferences, family details, addresses, medical context, or payment references.

Medical and family-related tasks are high-sensitivity. Keep the system to scheduling and logistics. Do not provide diagnosis, treatment advice, or childcare/legal advice.

## Outputs

Minimum output:

1. Current assumptions and unresolved blocking questions.
2. Ranked candidates with fit reasons, tradeoffs, and timestamps.
3. Recommended booking or scheduling path.
4. Approval preview showing the exact next external action.
5. Calendar/reminder proposal.

Full output:

1. Reservation packet.
2. Calendar event and reminder set.
3. Checklist for visit, delivery, event, or trip.
4. Receipt and reimbursement notes when relevant.
5. Personal preference update proposal.

## Testing

1. Validate that inline secrets, card numbers, session cookies, one-time codes, and raw medical identifiers are rejected.
2. Verify booking, purchase, payment, cancellation, and profile mutation actions are approval-gated.
3. Verify points portal execution captures evidence and has a fallback path.
4. Verify dynamic facts include timestamps and source references.
5. Verify the site selection preflight only asks tie-breaker questions when the choice is materially ambiguous.
6. Verify personal memory updates are proposed separately from execution and never written silently.
