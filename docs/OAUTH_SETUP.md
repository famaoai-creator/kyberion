# Kyberion OAuth Integration Setup Guide

Kyberion relies on a robust `service-actuator` to manage connections to third-party services securely. To establish an OAuth 2.0 integration (e.g., Notion, Canva), you must complete an OAuth handshake and allow Kyberion to securely store the tokens in its Sovereign Sanctuary (the Personal Tier).

This guide explains the flow and how to automate the setup using the built-in Kyberion pipeline.

## Overview of the OAuth Flow

1. **Client ID / Secret Acquisition:**
   - The user must create an integration on the provider's platform (e.g., Notion) and obtain a Client ID and Client Secret.
   - The user registers `http://localhost:8787/oauth/callback` as the valid OAuth Redirect URI on the provider's dashboard.
2. **Vault Storage:**
   - The user stores the credentials safely in Kyberion's local vault: `vault/secrets/secrets.json`.
3. **Background Callback Server:**
   - Kyberion starts an ephemeral callback server (`scripts/oauth_callback_surface.ts`) running locally on port 8787.
   - The setup entrypoint launches it with the `sovereign` persona (`KYBERION_PERSONA=sovereign`) so it has permission to write the acquired tokens into the Personal Tier.
4. **Authorization Code Flow:**
   - The user is provided with an Authorization URL. Opening this in the browser initiates the provider's consent screen.
   - Upon granting consent, the provider redirects the user to `http://localhost:8787/oauth/callback` with a one-time authorization code.
5. **Token Exchange & Persistence:**
   - The background server exchanges the code for an Access Token and saves it to `knowledge/personal/connections/<service>.json`.
   - The background server is then safely terminated.

---

## Setting up an OAuth Connection Automatically

We have created an interactive pipeline to automate steps 3 through 5 for you.

### Prerequisite: Provider Configuration

Before running the pipeline, ensure you have:
1. Created an OAuth integration on the provider (e.g. [Notion Integrations](https://www.notion.so/my-integrations)).
2. Set the redirect URI to: `http://localhost:8787/oauth/callback`
3. Obtained the **Client ID** and **Client Secret**.
4. Added them to your `vault/secrets/secrets.json` under the service key (e.g., `"notion"`):

```json
{
  "notion": {
    "client_id": "your-client-id",
    "client_secret": "your-client-secret"
  }
}
```

### Running the Setup Pipeline

To begin the interactive setup, run the following pipeline command, replacing `<service_name>` with your service (e.g., `notion`):

```bash
pnpm pipeline --input pipelines/setup-oauth.json --vars "service_name=notion"
```

If you want to run the entrypoint directly without the pipeline wrapper, use:

```bash
KYBERION_OAUTH_SERVICE_ID=notion node --import ./scripts/ts-loader.mjs scripts/setup_oauth.ts
```

### What the Pipeline Does
1. Checks that your secrets are correctly configured through the OAuth broker.
2. Launches the local OAuth Callback Server in the background with `KYBERION_PERSONA=sovereign` to allow Personal-tier writes.
3. Generates the correct Authorization URL from the service OAuth profile and prints it.
4. Waits for you to open the URL in your browser, click "Allow", and see the "Authorization Complete" screen.
5. Automatically terminates the background callback server and confirms that your access tokens are saved in `knowledge/personal/connections/<service_name>.json`.

You can then freely use the `service-actuator` to execute API commands for this service.
