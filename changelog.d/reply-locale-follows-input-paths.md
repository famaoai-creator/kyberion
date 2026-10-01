---
category: Fixed
---

- **Replies follow the user's language on more paths** — browser conversation candidate confirmation/commands and the capture-photo executor now derive the reply locale from the user's utterance (explicit > detected input language > scope > operator), and the iMessage processing note captures the turn locale when typing starts. Locale-sensitive tests are now pinned so they pass under both Japanese and `LANG=C` hosts.
