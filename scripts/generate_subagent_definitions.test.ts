import { afterEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import {
  SUBAGENT_CAPABILITY_PROFILES,
  SUBAGENT_PROFILE_CLI_TOOLS,
  pathResolver,
  safeReadFile,
  safeWriteFile,
} from '@agent/core';
import { withExecutionContext } from '@agent/core/governance';
import {
  GENERATED_ROLES,
  PROFILE_SPECS,
  buildAgentDefinitionSource,
  buildGeneratedFiles,
  condenseProcedure,
  main,
  resolveProfile,
} from './generate_subagent_definitions.js';

function agentPath(role: string): string {
  return path.join(pathResolver.rootResolve('.claude/agents'), `${role}.md`);
}

describe('generate_subagent_definitions', () => {
  it('maps team roles to KD-05 profiles deterministically', () => {
    expect(resolveProfile('implementer')).toBe('implementer');
    expect(resolveProfile('reviewer')).toBe('explorer');
    expect(resolveProfile('devils_advocate')).toBe('explorer');
    // Unlisted roles fall back to the safe (read-only) default rather than
    // silently inheriting write/exec access.
    expect(resolveProfile('some_future_role')).toBe('explorer');
  });

  it('generation is deterministic: two runs produce identical bytes', () => {
    const first = buildAgentDefinitionSource('implementer');
    const second = buildAgentDefinitionSource('implementer');
    expect(first).toBe(second);
    expect(first).not.toHaveLength(0);
  });

  it('condenses a PROCEDURE.md to its headings and bullets only, in order', () => {
    const markdown = [
      '# Title',
      '',
      'Some prose paragraph that should be dropped.',
      '',
      '## Section',
      '- bullet one',
      '- bullet two',
      'more prose',
    ].join('\n');
    expect(condenseProcedure(markdown)).toEqual([
      '# Title',
      '## Section',
      '- bullet one',
      '- bullet two',
    ]);
  });

  it('caps condensed output at maxLines', () => {
    const markdown = Array.from({ length: 20 }, (_, i) => `- item ${i}`).join('\n');
    expect(condenseProcedure(markdown, 5)).toHaveLength(5);
  });

  it('generated implementer definition contains the KD-05 framing, working principles, and secure-io constraint', () => {
    const source = buildAgentDefinitionSource('implementer');
    expect(source).toContain(PROFILE_SPECS.implementer.framing);
    expect(source).toContain(
      '## Working principles (apply mechanically; they override style preferences)'
    );
    expect(source).toContain('Make the smallest diff that satisfies the acceptance criteria');
    expect(source).toContain('## secure-io constraint');
    expect(source).toContain('never call `node:fs` directly');
    expect(source).toContain('GENERATED FILE — DO NOT EDIT BY HAND');
    expect(source).toContain(`tools: ${PROFILE_SPECS.implementer.tools.join(', ')}`);
  });

  it('explorer-mapped role definitions carry no write/execute tools', () => {
    for (const role of ['reviewer', 'devils_advocate']) {
      expect(resolveProfile(role)).toBe('explorer');
      const source = buildAgentDefinitionSource(role);
      const toolsLine = source.split('\n').find((line) => line.startsWith('tools:'));
      expect(toolsLine).toBeDefined();
      const tools = (toolsLine || '')
        .replace(/^tools:\s*/, '')
        .split(',')
        .map((t) => t.trim());
      expect(tools).toEqual([...PROFILE_SPECS.explorer.tools]);
      expect(tools).not.toContain('Edit');
      expect(tools).not.toContain('Write');
      expect(tools).not.toContain('Bash');
    }
  });

  it('Wave-3 drift prevention: PROFILE_SPECS is derived from the SSoT registry, not a hand-mirrored copy', () => {
    // Reference equality (not just deep-equal) proves PROFILE_SPECS.tools is
    // literally the SSoT's array, so a future edit to
    // libs/core/subagent-capability-profiles.ts's cliTools cannot silently
    // diverge from what this generator emits — there is no second array to
    // forget to update.
    for (const profile of SUBAGENT_CAPABILITY_PROFILES) {
      const spec = PROFILE_SPECS[profile.name as keyof typeof PROFILE_SPECS];
      expect(spec).toBeDefined();
      expect(spec.tools).toBe(SUBAGENT_PROFILE_CLI_TOOLS[profile.name]);
      expect(spec.framing).toBe(profile.systemPromptPrefix);
    }
  });

  describe('--check against the committed .claude/agents files', () => {
    const originals = new Map<string, string>();

    afterEach(() => {
      withExecutionContext('generate_subagent_definitions', () => {
        for (const [role, content] of originals) {
          safeWriteFile(agentPath(role), content);
        }
      });
      originals.clear();
    });

    it('passes when the committed files match the generator output', async () => {
      const built = await buildGeneratedFiles();
      for (const role of GENERATED_ROLES) {
        const onDisk = String(safeReadFile(agentPath(role), { encoding: 'utf8' }) || '');
        expect(onDisk).toBe(built.get(role));
      }

      process.exitCode = undefined;
      await main(['--check']);
      expect(process.exitCode).toBeUndefined();
    });

    it('fails --check when a generated file is tampered with, and recovers after restore', async () => {
      const role = 'reviewer';
      const filePath = agentPath(role);
      const original = String(safeReadFile(filePath, { encoding: 'utf8' }) || '');
      originals.set(role, original);

      withExecutionContext('generate_subagent_definitions', () => {
        safeWriteFile(filePath, `${original}\n<!-- tampered -->\n`);
      });

      process.exitCode = undefined;
      await main(['--check']);
      expect(process.exitCode).toBe(1);

      // restore and confirm the check goes green again
      withExecutionContext('generate_subagent_definitions', () => {
        safeWriteFile(filePath, original);
      });
      process.exitCode = undefined;
      await main(['--check']);
      expect(process.exitCode).toBeUndefined();
    });
  });
});
