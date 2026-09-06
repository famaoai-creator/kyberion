import { describe, expect, it } from 'vitest';
import { safeReadFile } from '@agent/core/secure-io';
import * as path from 'node:path';

describe('voice-hub TTS artifact lifecycle contract', () => {
  it('uses the shared native TTS command on every supported platform', () => {
    const source = String(
      safeReadFile(path.resolve(process.cwd(), 'satellites/voice-hub/server.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).toContain("import { buildNativeTtsCommand } from '@agent/core/native-tts';");
    expect(source).toContain('const command = buildNativeTtsCommand(text, {');
    expect(source).not.toContain("process.platform !== 'darwin'");
    expect(source).not.toContain("'/usr/bin/say'");
  });

  it('cleans generated artifacts after playback and on bridge failure', () => {
    const source = String(
      safeReadFile(path.resolve(process.cwd(), 'satellites/voice-hub/server.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).toContain('if (safeExistsSync(tmpPath)) safeRmSync(tmpPath, { force: true });');
    expect(source).toContain(
      'if (safeExistsSync(artifactPath)) safeRmSync(artifactPath, { force: true });'
    );
    expect(source).toContain('finally {\n      if (safeExistsSync(artifactPath))');
  });

  it('validates the generated artifact before playback', () => {
    const source = String(
      safeReadFile(path.resolve(process.cwd(), 'satellites/voice-hub/server.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).toContain(
      "const safeArtifactPath = resolveRegularRepositoryFile(artifactPath, 'TTS artifact');"
    );
    expect(source).toContain("spawn('/usr/bin/afplay', [safeArtifactPath]");
  });
});
