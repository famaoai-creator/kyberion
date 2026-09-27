# Changelog fragments

Do not edit `CHANGELOG.md` in a pull request. Every PR that edited the top of
`[Unreleased]` conflicted with every other open PR. Instead, a PR with a
user-visible change adds **one new file** here:

```markdown
---
category: Added
---

- **Short name** — what changed for the user, and what they need to do (if anything).
```

- **File name**: `<short-slug>.md`, lowercase letters, digits and dashes
  (for example `kyberion-draw-verb.md`). Use a name no other PR will pick —
  the topic of your branch works.
- **`category`**: one of `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`,
  `Security` ([Keep a Changelog](https://keepachangelog.com/en/1.1.0/)).
- **Body**: one or more Markdown list items (`- ...`), no headings. Behaviour
  changes and migrations belong in the text.

The `changelog-fragments` gate (`pnpm check -- --scope pr`) validates the
format. The release process runs `pnpm kyberion changelog assemble`, which
moves every fragment into `CHANGELOG.md` `[Unreleased]` (newest first under the
matching heading) and deletes the fragments — see
[`docs/developer/RELEASE_OPERATIONS.md`](../docs/developer/RELEASE_OPERATIONS.md).
