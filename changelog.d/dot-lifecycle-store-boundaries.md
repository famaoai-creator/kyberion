---
category: Fixed
---

- Separate Dot charter and lifecycle runtime store permissions. Internal store roles cannot become a Dot's execution role. Preserve legitimate confidential and personal runtime writes while denying direct knowledge access and cross-tenant operations.

- Preserve required denial auditing from narrow stores through the existing audit-owned persistence context. Capture original attribution before persistence and retain caller resource ceilings.

- Capture callback-free audit payloads under caller authority before persistence or deferral, so getters and serializers cannot inherit audit-store authority. Reject invalid payloads before appending.

- Preserve the active caller tenant when optional audit tenant fields are empty, while retaining legitimate unbound and explicitly cleared global events.
