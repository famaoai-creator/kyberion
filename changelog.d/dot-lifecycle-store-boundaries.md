---
category: Fixed
---

- Separate Dot charter and lifecycle runtime store permissions. Internal store roles cannot become a Dot's execution role. Preserve legitimate confidential and personal runtime writes while denying direct knowledge access and cross-tenant operations.

- Preserve required denial auditing from narrow stores through the existing audit-owned persistence context. Capture original attribution before persistence and retain caller resource ceilings.
