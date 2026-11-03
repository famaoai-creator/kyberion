---
category: Fixed
---

- Saving a Concierge settings section now changes only what was edited. Profile and Services used to resubmit the whole onboarding draft with built-in defaults, which silently reset the language, interaction style, agent display name / provider / model, provider priority and tool modes. They now send a patch (`save_settings`), and the server merges it onto the stored values.
- Advanced → management save no longer falls back to `KYBERION_TENANT` or `default`, and no longer creates a `default` tenant. It is refused with `TENANT_SELECTION_REQUIRED` until a registered tenant is selected.
- Voice registration and management saves now show their success or failure, including the server's reason, next to their own button.
