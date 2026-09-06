import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

const ENTRYPOINTS = [
  'scripts/agent_runtime_supervisor_daemon.ts',
  'scripts/bootstrap_environment.ts',
  'scripts/company_bootstrap.ts',
  'scripts/compose_mission_team.ts',
  'scripts/kyberion_home.ts',
  'scripts/meeting_orchestrator.ts',
  'scripts/meeting_participate.ts',
  'scripts/meeting_preflight.ts',
  'scripts/minutes_record.ts',
  'scripts/mission_controller.ts',
  'scripts/onboarding_apply.ts',
  'scripts/onboarding_wizard.ts',
  'scripts/run_doctor.ts',
] as const;

describe('mission execution environment boundary', () => {
  it('routes mission context reads and writes through the registered environment API', () => {
    for (const entrypoint of ENTRYPOINTS) {
      const source = String(
        safeReadFile(pathResolver.rootResolve(entrypoint), { encoding: 'utf8' })
      );
      expect(source, entrypoint).not.toMatch(/process\.env\.MISSION_(?:ID|ROLE)/u);
      expect(source, entrypoint).toContain('setRegisteredEnv');
    }
  });
});
