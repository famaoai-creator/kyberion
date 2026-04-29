# Presentation Preference Profile

`presentation-preference-profile.schema.json` stores reusable preferences for slide briefs and theme selection.

It separates:

- brief questions for the current deck
- theme selection for the current audience and tone
- a light policy for when Kyberion should ask before choosing a theme

Use it when the request is closer to "write a deck" than "answer a question". The content brief should stay separate from visual styling.

`brief_question_sets` tells Kyberion which first 1-3 questions to ask for a given deck purpose.

`theme_sets` tells Kyberion which visual theme to prefer for that purpose.

The profile is intentionally smaller than the booking profile. It does not need payment, login, or points routing. Its job is to keep deck intent, audience, and design consistent without hard-coding every branch as regex logic.
