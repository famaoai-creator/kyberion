---
name: ky-review
description: Run the Kyberion review/distill phase — capture learnings and clean up. Equivalent of the Claude Code plugin's /ky-review for Devin sessions; use at the end of substantive work or when the user asks to close/review a change.
---

# Kyberion Review Phase (Devin)

The Claude Code plugin ships `/ky-review` as a slash command
(`plugins/kyberion-claude-code/commands/ky-review.md`). In a Devin session
that command does not exist; run the same phase manually:

1. **Distill learnings.** Promote what the session proved — verified
   semantics, fixed defects, useful commands — into `knowledge/` with
   frontmatter (`title`, `tags`, `last_updated`), or update the doc that
   already owns the topic. When a mission is active, record through the
   mission's evidence/review tooling (`record-evidence`, `review-task`)
   instead of editing mission state by hand.
2. **Clean up temp files.** Scratch belongs under `active/shared/tmp/` or
   mission-local dirs only — remove or relocate anything left elsewhere;
   check `git status` for stray artifacts.
3. **Verify the audit trail.** The session's Write/Edit/Bash actions are
   recorded automatically by the provider hooks; if integrity needs
   confirming, run `pnpm kyberion audit verify` (or the equivalent
   `kyberion.audit.verify` call when MCP tools are available).
4. **Summarize.** Report what was learned, what was promoted to knowledge,
   and what remains open — in Japanese unless the session used another
   language.
