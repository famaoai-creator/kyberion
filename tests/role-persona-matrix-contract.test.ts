import { describe, expect, it } from 'vitest';
import { safeReadFile } from '@agent/core/secure-io';

describe('Role / Persona matrix contract', () => {
  it('documents the distinction between personas, roles, and permissions', () => {
    const doc = safeReadFile('docs/developer/ROLE_PERSONA_MATRIX.md', { encoding: 'utf8' }) as string;

    expect(doc).toContain('the design direction is to keep **service names out of `persona`, `role`, and `authority` names**');
    expect(doc).toContain('Service-specific names belong in **surface instances** and **transport config**');
    expect(doc).toContain('Persona | Broad trust envelope and operating mode.');
    expect(doc).toContain('Authority role | Concrete job function for execution-time write scopes and surface boundaries.');
    expect(doc).toContain('Permission | The actual path or authority grant enforced by tier-guard and secure-io.');
    expect(doc).toContain('`surface_runtime` does not imply `slack_bridge`.');
    expect(doc).toContain('`slack_bridge` does not imply `surface_runtime`.');
    expect(doc).toContain('`mission_controller` does not imply `software_developer`.');
    expect(doc).toContain('`knowledge_steward` does not imply `sovereign`.');
    expect(doc).toContain('If a workflow touches both a runtime surface and Slack transport, it needs both boundaries satisfied.');
    expect(doc).toContain('Current surface instances: `slack-bridge`, `imessage-bridge`, `telegram-bridge`, `terminal-bridge`');
    expect(doc).toContain('A **surface instance** is a running integration or daemon with a concrete `id`.');
    expect(doc).toContain('Prefer responsibility names over service names.');
    expect(doc).toContain('Existing service-specific surface instances such as `imessage-bridge` are cataloged as runtime surfaces');
    expect(doc).toContain('The role should tell you what boundary it owns, not which vendor it happens to route through.');
    expect(doc).toContain('Persona, authority, and role should stay generic.');
  });

  it('documents the current persona and role mapping at the boundary level', () => {
    const doc = safeReadFile('docs/developer/ROLE_PERSONA_MATRIX.md', { encoding: 'utf8' }) as string;

    expect(doc).toContain('`sovereign_concierge` | `sovereign`');
    expect(doc).toContain('`mission_controller`, `software_developer`, `slack_bridge`, `chronos_gateway`, `chronos_operator`, `chronos_localadmin`, `surface_runtime`, `infrastructure_sentinel`, `service_actuator`');
    expect(doc).toContain('`knowledge_steward`, `ruthless_auditor`, `cyber_security`');
    expect(doc).toContain('`service_actuator` | not auto-inferred');
    expect(doc).toContain('`run_pipeline` | not auto-inferred');
    expect(doc).toContain('`run_super_pipeline` | not auto-inferred');
    expect(doc).toContain('`nexus_daemon` | not auto-inferred');
  });
});
