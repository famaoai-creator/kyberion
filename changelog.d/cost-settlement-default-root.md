---
category: Fixed
---

- Chronos cost summary (`/api/cost`) no longer always answers 500. Generation-cost settlements passed the repository root itself to the path guard, which only admits paths inside the root, so every default-root read and write threw `[RESOURCE_PATH_SCOPE]`.
- Concierge training progress no longer tells an owner "only owners can manage members" in the personal view. With no tenant selected it returns an empty overview and `tenant_selection_required`.
