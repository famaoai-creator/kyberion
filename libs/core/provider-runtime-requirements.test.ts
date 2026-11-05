import { describe, expect, it } from 'vitest';

import {
  runtimeSetupHint,
  runtimeSetupHintsFromCandidates,
  unmetRuntimeRequirements,
  type RuntimeRequirementContext,
} from './provider-runtime-requirements.js';

const installedCtx: RuntimeRequirementContext = {
  platform: 'darwin',
  arch: 'arm64',
  env: {},
  isManagedToolInstalled: () => true,
};

const missingCtx: RuntimeRequirementContext = {
  platform: 'darwin',
  arch: 'arm64',
  env: {},
  isManagedToolInstalled: () => false,
  isToolBinaryResolvable: () => false,
};

describe('unmetRuntimeRequirements', () => {
  it('returns empty for undefined or satisfied requirements', () => {
    expect(unmetRuntimeRequirements(undefined, installedCtx)).toEqual([]);
    expect(
      unmetRuntimeRequirements(
        { platforms: ['darwin'], accelerator: 'mlx', managed_tool_id: 'mlx_whisper' },
        installedCtx
      )
    ).toEqual([]);
  });

  it('reports platform mismatches with the accepted set', () => {
    expect(
      unmetRuntimeRequirements({ platforms: ['darwin'] }, { ...installedCtx, platform: 'linux' })
    ).toEqual(['platform:darwin']);
  });

  it('reports accelerator requirements unmet off Apple Silicon', () => {
    expect(
      unmetRuntimeRequirements({ accelerator: 'mlx' }, { ...installedCtx, platform: 'linux' })
    ).toEqual(['accelerator:mlx']);
    expect(
      unmetRuntimeRequirements({ accelerator: 'metal' }, { ...installedCtx, platform: 'linux' })
    ).toEqual(['accelerator:metal']);
    expect(
      unmetRuntimeRequirements({ accelerator: 'cuda' }, { ...installedCtx, platform: 'linux' })
    ).toEqual([]);
  });

  it('reports managed runtimes via the injected probe', () => {
    expect(unmetRuntimeRequirements({ managed_tool_id: 'mlx_whisper' }, missingCtx)).toEqual([
      'managed_runtime:mlx_whisper',
    ]);
    expect(unmetRuntimeRequirements({ managed_tool_id: 'mlx_whisper' }, installedCtx)).toEqual([]);
  });

  it('reports unset env commands through the env registry', () => {
    expect(unmetRuntimeRequirements({ env_command: 'KYBERION_TTS_COMMAND' }, installedCtx)).toEqual(
      ['env:KYBERION_TTS_COMMAND']
    );
  });

  it('reports unset non-command env vars through the env registry', () => {
    expect(
      unmetRuntimeRequirements(
        { env_vars: ['KYBERION_VOICE_PROFILE_ID', 'KYBERION_TTS_COMMAND'] },
        { ...installedCtx, env: { KYBERION_VOICE_PROFILE_ID: 'p1' } }
      )
    ).toEqual(['env:KYBERION_TTS_COMMAND']);
  });

  it('reports external tool binaries via the injected probe', () => {
    const spec = { toolId: 'speech_cpp', envNames: ['KYBERION_SPEECH_CPP_BIN'], binary: 'speech' };
    expect(unmetRuntimeRequirements({ tool_binary: spec }, missingCtx)).toEqual([
      'tool_binary:speech_cpp',
    ]);
    expect(
      unmetRuntimeRequirements(
        { tool_binary: spec },
        { ...missingCtx, isToolBinaryResolvable: () => true }
      )
    ).toEqual([]);
  });

  it('composes multiple unmet reasons', () => {
    expect(
      unmetRuntimeRequirements(
        {
          platforms: ['darwin'],
          accelerator: 'mlx',
          managed_tool_id: 'mlx_whisper',
          env_command: 'KYBERION_TTS_COMMAND',
        },
        missingCtx
      )
    ).toEqual(['managed_runtime:mlx_whisper', 'env:KYBERION_TTS_COMMAND']);
  });
});

describe('runtimeSetupHint', () => {
  it('maps managed_runtime unmets to the governed tool:setup command', () => {
    expect(runtimeSetupHint(['managed_runtime:mlx_whisper'])).toBe(
      'pnpm tool:setup -- --tool mlx_whisper --apply'
    );
  });

  it('maps tool_binary unmets to the governed tool:setup command', () => {
    expect(runtimeSetupHint(['tool_binary:speech_cpp'])).toBe(
      'pnpm tool:setup -- --tool speech_cpp --apply'
    );
  });

  it('maps env unmets to the variable name', () => {
    expect(runtimeSetupHint(['env:KYBERION_TTS_COMMAND'])).toBe('set KYBERION_TTS_COMMAND');
  });

  it('returns undefined when no actionable unmet exists', () => {
    expect(runtimeSetupHint(['platform:darwin', 'synthetic output not allowed'])).toBeUndefined();
  });
});

describe('runtimeSetupHintsFromCandidates', () => {
  it('dedupes hints across excluded candidates', () => {
    expect(
      runtimeSetupHintsFromCandidates([
        { unmet: ['managed_runtime:mlx_whisper'] },
        { unmet: ['managed_runtime:mlx_whisper', 'env:KYBERION_TTS_COMMAND'] },
        { unmet: ['language ja'] },
      ])
    ).toEqual(['pnpm tool:setup -- --tool mlx_whisper --apply', 'set KYBERION_TTS_COMMAND']);
  });
});
