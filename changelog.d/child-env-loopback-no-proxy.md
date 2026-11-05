---
category: Security
---

- **Loopback NO_PROXY for every child env** — when HTTP(S)_PROXY is passed to a child process (exec helpers, provider CLIs, ACP agents), `127.0.0.1,localhost,::1` is now always appended to `NO_PROXY`/`no_proxy`, so a proxy-honoring child reaches local services such as the credential relay directly. On a Node runtime whose `https.Agent` ignores `proxyEnv` (before 24.5) the credential relay logs a one-time warning instead of silently bypassing the proxy; upgrade Node to fix it.
