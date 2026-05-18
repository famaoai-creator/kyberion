# Procedure: Email Triage and Reply Draft

## 1. Goal
Turn unread Gmail items into a local triage note and a reply-ready draft so response work is faster and less error-prone.

This workflow is split into two surfaces:
- **Web**: `Presence Studio` for browsing triage, reviewing drafts, and approving send actions.
- **CLI**: `pnpm email:workflow ...` for status checks, draft generation, and delivery from the terminal.

## 2. Dependencies
- **Service preset**: `google-workspace`
- **CLI**: `gws` with Gmail auth configured

### Gmail Auth Setup
1. Check `gws auth status`.
2. If no OAuth client is configured, provide either:
   - `/Users/famao/.config/gws/client_secret.json`
   - `GOOGLE_WORKSPACE_CLI_CLIENT_ID` and `GOOGLE_WORKSPACE_CLI_CLIENT_SECRET`
3. Authenticate:
   - `gws auth login --services gmail --readonly` for triage only
   - `gws auth login --services gmail` for draft and send actions
4. If `gcloud` is available, `gws auth setup --project <gcp-project-id> --login` can configure the client and login in one step.

## 3. Recommended Flow
1. Run `pipelines/email-triage-and-reply-draft.json`.
2. Review the generated artifact at `active/shared/tmp/email-inbox-triage.md`.
3. Open `Presence Studio`, use `Create Reply Draft`, and confirm the generated reply body.
4. If you want a Gmail draft, click `Create Gmail Draft`.
5. If you are ready to send, check `I approve sending this email` and click `Send Approved Email`.
6. Copy the reply draft into Gmail or your mail client when you want to send manually.

### CLI Flow
1. Check Gmail auth status with `pnpm cli -- email status` or `pnpm email:workflow status`.
2. Generate a reply draft with `pnpm cli -- email draft --triage-file active/shared/tmp/email-inbox-triage.md`.
3. Inspect the latest stored draft with `pnpm cli -- email latest-draft`.
4. Create a Gmail draft or send an approved message with `pnpm cli -- email deliver ...`.

## 4. What It Helps With
- Summarizing unread mail into one place
- Creating a reply draft from the triage output
- Creating a Gmail draft or sending after explicit approval
- Keeping the reply draft next to the triage output
- Reducing context switching between inbox review and response writing

## 5. Notes
- This flow is intentionally local-first. It prepares the reply text, but final sending stays in your mail client or an external mail automation flow.
- If `gws auth status` fails, authenticate before running the pipeline.
- For production sending, prefer `Create Gmail Draft` first and only use `Send Approved Email` after reviewing the draft.
- The Web and CLI surfaces share `libs/core/email-workflow.ts`, so draft parsing, auth checks, and Gmail delivery stay consistent.
- `pnpm email:workflow ...` remains as a direct helper for lower-level automation, but `pnpm cli -- email ...` is the preferred human-facing CLI entrypoint.
