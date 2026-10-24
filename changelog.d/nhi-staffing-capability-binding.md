## feat(governance): role-driven capability binding for mission dispatch

Mission task dispatch now resolves the delegated capability tier from the
team role × task purpose (`resolveDelegationCapabilityProfile`) instead of
the purpose alone — a reviewer staffed for implementation stays read-only.
Providers that cannot project the required tier are refused fail-closed
(`assertProviderCanProjectProfile`; e.g. codex/devin/agy × planner), and the
resolved tier rides the A2A delegation context into the runtime worker.
