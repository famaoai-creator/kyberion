---
category: Fixed
---

- Initialize only the capabilities a command needs: help and storage maintenance no longer depend on reasoning credentials.
- Distinguish missing tenant task bindings from inconsistent scope, preserve strict service authorization, and report actionable blocked readiness without repeated provider probes.
- Install secret resolution before backend selection and validate execution identity before reusing or refreshing cached reasoning backends.
