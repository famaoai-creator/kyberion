---
category: Changed
---

- Move deck theme direction, legacy media operations, spreadsheet style policy,
  tracker sheet policy, and visual workflow compilers from `@agent/core` to
  `@agent/shared-media`. Update direct consumers and test mocks to their new subpaths.
- Preserve policy catalog loading, theme selection, section drafting, and image/video
  compilation behavior. Foundation, reasoning, contracts, design-system, and resource
  authorization helpers remain in core without a reverse package dependency.
- Transfer five explicit package exports and their existing regression suites to
  shared-media, with build-contract checks for source and compiled ownership.
