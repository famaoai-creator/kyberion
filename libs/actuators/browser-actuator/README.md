# Isolated public navigation after onboarding

A stored browser origin grant authorizes only the named `browser:goto` or
`browser:open_tab` operation in a trusted **public** execution context. The
installed, active NHI and accountable owner must match the reviewed onboarding
configuration. Existing profiles, CDP sessions, clicks, scripts and forms keep
their individual approval requirements.

For a normal Kyberion pipeline step, request the restricted browser mode:

```json
{
  "id": "read-approved-public-page",
  "op": "browser:goto",
  "params": {
    "url": "https://example.com/public",
    "onboarding_isolated_navigation": true
  }
}
```

The actuator creates a fresh scratch profile with service workers and page
JavaScript disabled, blocks downloads, and closes/deletes the profile when the
operation ends. A context-wide network fence starts with no allowed origin;
only successful shared admission opens HTTPS GET/HEAD requests to the approved
origin. Redirects, URL queries/fragments, other origins and request methods are
blocked. This mode intentionally does not support sign-in or interactive web
applications. It returns the visited URL and action receipt; it does not retain
a session for a later pipeline step.

The direct actuator envelope supports the same configuration through
`options.onboarding_isolated_navigation: true`. A direct envelope may include
local observation steps, such as a screenshot, after navigation. Profile/CDP,
session, launch argument and recording overrides are rejected. Neither form of
the option supplies authority: absent, expired, stopped or mismatched grants
still fail closed through the shared gate.
