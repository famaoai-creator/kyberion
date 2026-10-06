---
category: Fixed
---

- **Tenant conversations no longer leave utterance text in the shared unhandled-intent registry** — an unrecognized tenant turn is not recorded there at all, and an unrouted one keeps only its intent ID. Non-tenant turns are recorded as before.
