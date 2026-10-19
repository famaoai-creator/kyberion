import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

describe('meeting actuator resource boundary', () => {
  it('revalidates voice consent evidence before reading', () => {
    // PG-04: speak consent delegates to the coordinator's single mission
    // voice-consent check, which revalidates the evidence path before reading.
    const source = String(
      safeReadFile(
        pathResolver.rootResolve('libs/actuators/meeting-actuator/src/meeting-session.ts'),
        { encoding: 'utf8' }
      )
    );
    expect(source).toContain('checkMeetingParticipationConsent(');
    expect(source).toMatch(/purpose:\s*'voice'/u);

    const shared = String(
      safeReadFile(pathResolver.rootResolve('libs/core/voice/voice-consent.ts'), {
        encoding: 'utf8',
      })
    );
    expect(shared).toContain('consentPath = assertSafeRepositoryPath(');
    expect(shared).toMatch(/allowMissingLeaf:\s*true/u);
  });

  it('keeps the canonical consent entrypoint re-exported from the helpers', () => {
    const helpers = String(
      safeReadFile(
        pathResolver.rootResolve('libs/actuators/meeting-actuator/src/meeting-actuator-helpers.ts'),
        { encoding: 'utf8' }
      )
    );
    expect(helpers).toContain('checkSpeakConsent');
    expect(helpers).toContain('./meeting-session.js');
  });
});
