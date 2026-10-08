# Concierge local peer adapter and analysis boundary

The local operator entry is `presence/displays/concierge/server/local-server.ts`.
Node 24 runs its erasable TypeScript directly, without a custom loader, tsx, or
an authentication environment switch. Its typed peer implementation is
`local-peer.ts`; there is no unanalysed JavaScript wrapper. The normal Next
dev/start commands continue to support authenticated remote deployment.

## Coverage contract

The role analyzer resolves a surface command relative to its declared cwd.
For a resolved server in a package declaring Next and containing app/pages
sources, it conservatively includes the server, helpers, and all authored Next
app sources. This covers routes discovered by Next at runtime rather than
through server imports. Dependency code, compiled dist/.next, declarations,
tests, and outside-workspace paths remain excluded.

The introduced server and peer use the analyzer's established TypeScript source
boundary. Regression fixtures assert both modules and the actual middleware,
operator route, and headless route appear. Synthetic custom-server fixtures
also assert unresolved relative and computed imports in the peer chain become
unresolved authority sites. Existing contract tests still require narrowed
roles to have no unresolved sites and grant every proven reachable role.
No role grants or those contract assertions were relaxed.

## Legacy JavaScript limitation discovered during integration

A trial expansion to all repository JavaScript sources was not safe to adopt
as a small adapter integration. With the analyzer's noLib/types=[] compiler
host, JavaScript assignment `process.argv = ...` at
`scripts/run_built.mjs:27` was treated as a declaration for global process
references in unrelated TypeScript modules. The identifier graph consequently
linked core/surface-runtime code to the launcher without a real import or call.

Separately, the launcher's failure path dynamically imports script-harness and
uses only renderScriptError. The current computed-import model conservatively
reaches every exported unit, including defineGenerator, whose default execution
role is ecosystem_architect. Together these produced false-positive daemon
paths to that role. The launcher's argv-dependent dynamic import is a real
legacy analysis limitation, even though those reported daemon chains were not
proof of actual runtime invocation.

The repository-wide JavaScript expansion was withdrawn; the prior TypeScript
analysis boundary is retained. This is not an exception hiding the new adapter:
its complete introduced implementation is TypeScript and remains analyzed.
Accurate legacy JavaScript coverage requires separate work on global-object
symbol provenance and computed-import export precision. Until then, the role
report must not be described as comprehensive analysis of JavaScript launchers.
