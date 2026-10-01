import { describe, expect, it } from 'vitest';
import type { AgentManifest } from '../agent/agent-manifest.js';
import {
  evaluateAcpManifestToolPolicy,
  resolveAcpToolActuators,
} from './acp-tool-actuator-resolver.js';

const manifest = (over: Partial<AgentManifest>): AgentManifest =>
  ({ allowedActuators: [], deniedActuators: [], ...over }) as AgentManifest;

describe('acp-tool-actuator-resolver', () => {
  it('keeps legacy mappings', () => {
    expect(resolveAcpToolActuators('Run_Shell_Command')).toContain('system-actuator');
    expect(resolveAcpToolActuators('write_file')).toContain('file-actuator');
    expect(resolveAcpToolActuators('curl x')).toContain('network-actuator');
    expect(resolveAcpToolActuators('navigate')).toContain('browser-actuator');
  });

  it('derives terminal/secret/process/android/code from manifests', () => {
    expect(resolveAcpToolActuators('terminal spawn')).toContain('terminal-actuator');
    expect(resolveAcpToolActuators('secret get')).toContain('secret-actuator');
    expect(resolveAcpToolActuators('process kill')).toContain('process-actuator');
    expect(resolveAcpToolActuators('android tap')).toContain('android-actuator');
    expect(resolveAcpToolActuators('code edit')).toContain('code-actuator');
  });

  it('denies blacklisted terminal and secret actuators', () => {
    const m = manifest({ deniedActuators: ['terminal-actuator', 'secret-actuator'] });
    expect(evaluateAcpManifestToolPolicy(m, 'terminal spawn').allowed).toBe(false);
    expect(evaluateAcpManifestToolPolicy(m, 'secret write').allowed).toBe(false);
    expect(evaluateAcpManifestToolPolicy(m, 'write_file').allowed).toBe(true);
  });

  it('fails closed on unknown tools only when restrictions exist', () => {
    const m = manifest({ deniedActuators: ['terminal-actuator'] });
    const v = evaluateAcpManifestToolPolicy(m, 'frobnicate widgets');
    expect(v.allowed).toBe(false);
    expect(evaluateAcpManifestToolPolicy(manifest({}), 'frobnicate widgets').allowed).toBe(true);
    expect(evaluateAcpManifestToolPolicy(m, 'Search files').allowed).toBe(true);
  });

  it('respects allowlist for known tools', () => {
    const m = manifest({ allowedActuators: ['file-actuator'] });
    expect(evaluateAcpManifestToolPolicy(m, 'read_file').allowed).toBe(true);
    expect(evaluateAcpManifestToolPolicy(m, 'run_shell_command').allowed).toBe(false);
  });
});
