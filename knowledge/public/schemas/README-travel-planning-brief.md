# Travel Planning Brief

`travel-planning-brief.schema.json` is the high-level contract for travel planning before an agent compiles the work into executable ADF.

Use it after the travel coordinator has captured the user's request and resolved the blocking hearing questions.
The operating playbook is [travel-planning-playbook.md](knowledge/public/orchestration/travel-planning-playbook.md).

Use the brief for intent capture and review:

- who is traveling
- when and where they are traveling
- why the trip matters
- what dynamic facts must be checked
- which actions require approval
- what output the operator expects

Keep booking preferences in `booking-preference-profile` instead of this brief. That profile should hold preferred booking sites, points portal routing, payment policy, receipt needs, and credential references.

If the decision depends on current sales, campaigns, or whether the user wants to switch away from their usual sites for this run, use `site_selection_policy` in the booking profile. Do not store that live selection logic in the brief; keep the brief focused on the trip itself.

Do not put raw passwords, card numbers, session cookies, or one-time codes in this brief. Use profile references and approval gates instead.
