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
  AGY_PROFILE_TOOLS,
  agyAgentName,
  buildAgyAgentDefinitionSource,
  extractAgentDefinitionBody,
} from './agy-agent-definition-adapter.js';
import {
  GENERATED_ROLES,
  PROFILE_SPECS,
  SHARED_DIRECTORY_RULES_LINES,
  buildAgentDefinitionSource,
  buildGeneratedAgyFiles,
  buildGeneratedFiles,
  condenseProcedure,
  main,
  resolveProfile,
} from './generate_subagent_definitions.js';

function agentPath(role: string): string {
  return path.join(pathResolver.rootResolve('.claude/agents'), `${role}.md`);
}

function agyAgentPath(role: string): string {
  return path.join(pathResolver.rootResolve('.agents/agents'), agyAgentName(role), 'agent.md');
}

describe('generate_subagent_definitions', () => {
  it('uses the governed team-role loader', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/generate_subagent_definitions.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).toContain('loadTeamRoleIndex()');
    expect(source).toContain("readTextFile } from '@agent/core/foundation'");
    expect(source).not.toContain('safeReadFile(filePath');
    expect(source).not.toContain('readJson<');
  });

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
    expect(source).toContain('## Provider runtime instructions');
    expect(source).toContain('## secure-io constraint');
    expect(source).toContain('never call `node:fs` directly');
    expect(source).toContain('GENERATED FILE — DO NOT EDIT BY HAND');
    expect(source).toContain(`tools: ${PROFILE_SPECS.implementer.tools.join(', ')}`);
  });

  it('projects the same governed body into AGY custom-subagent frontmatter', () => {
    const source = buildAgentDefinitionSource('implementer');
    const agy = buildAgyAgentDefinitionSource({
      role: 'implementer',
      description: 'Produces the main code and configuration changes.',
      profile: 'implementer',
      body: extractAgentDefinitionBody(source),
    });

    expect(agy).toContain('name: kyberion-implementer');
    expect(agy).toContain('subagent: true');
    expect(agy).toContain('mainAgent: true');
    expect(agy).toContain('commandExecutionPolicy: sandbox');
    expect(agy).toContain('  - replace_file_content');
    expect(agy).toContain('You are a delegated implementer sub-agent.');
    expect(agy).not.toContain('tools: Read, Grep, Glob');
  });

  it('keeps AGY tool vocabulary provider-specific and least-privileged', () => {
    expect(AGY_PROFILE_TOOLS.implementer).toEqual([
      'view_file',
      'grep_search',
      'replace_file_content',
      'run_command',
    ]);
    expect(AGY_PROFILE_TOOLS.explorer).toEqual(['view_file', 'grep_search']);
    expect(AGY_PROFILE_TOOLS.planner).toEqual([]);
    expect(agyAgentName('devils_advocate')).toBe('kyberion-devils-advocate');
  });

  it('generated definitions carry the XP-04 shared-directory rules matrix and canonical link', () => {
    for (const role of GENERATED_ROLES) {
      const source = buildAgentDefinitionSource(role);
      expect(source).toContain('## Shared-directory rules (multi-provider co-execution)');
      expect(source).toContain(
        'Write only what your active work-item claim covers — never a file outside your assignment scope.'
      );
      expect(source).toContain(
        "Never touch `.git/` or repo config (`.gitignore`, workspace wiring, etc.) — that's the mission owner's, never a worker CLI's."
      );
      expect(source).toContain('Temp files only under `active/shared/tmp/`');
      expect(source).toContain(
        'Do not create or hand-edit provider state directories (`.claude/`, `.codex/`, `.agy/`, `.gemini/`, …)'
      );
      expect(source).toContain(
        '[multi-provider-coexecution-contract](../../knowledge/product/governance/multi-provider-coexecution-contract.md)'
      );
      // The section is built from the single exported const, not
      // re-typed prose in this test, so a future edit to
      // SHARED_DIRECTORY_RULES_LINES cannot silently drift from what
      // buildAgentDefinitionSource emits.
      expect(source).toContain(SHARED_DIRECTORY_RULES_LINES.join('\n'));
    }
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
      const agyBuilt = await buildGeneratedAgyFiles();
      for (const role of GENERATED_ROLES) {
        const onDisk = String(safeReadFile(agentPath(role), { encoding: 'utf8' }) || '');
        expect(onDisk).toBe(built.get(role));
        const agyOnDisk = String(safeReadFile(agyAgentPath(role), { encoding: 'utf8' }) || '');
        expect(agyOnDisk).toBe(agyBuilt.get(role));
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

    it('fails --check when only the shared-directory rules section is tampered with, and recovers after restore', async () => {
      const role = 'implementer';
      const filePath = agentPath(role);
      const original = String(safeReadFile(filePath, { encoding: 'utf8' }) || '');
      originals.set(role, original);
      expect(original).toContain('## Shared-directory rules (multi-provider co-execution)');

      // Corrupt only the matrix section (e.g. a weakened rule slipped in by
      // hand) while leaving the rest of the file byte-identical, proving
      // --check's diff is sensitive to this section specifically.
      const tampered = original.replace(
        'Never touch `.git/` or repo config',
        'Feel free to touch `.git/` or repo config'
      );
      expect(tampered).not.toBe(original);

      withExecutionContext('generate_subagent_definitions', () => {
        safeWriteFile(filePath, tampered);
      });

      process.exitCode = undefined;
      await main(['--check']);
      expect(process.exitCode).toBe(1);

      withExecutionContext('generate_subagent_definitions', () => {
        safeWriteFile(filePath, original);
      });
      process.exitCode = undefined;
      await main(['--check']);
      expect(process.exitCode).toBeUndefined();
    });

    it('fails --check when an AGY definition is tampered with, and recovers after restore', async () => {
      const role = 'implementer';
      const filePath = agyAgentPath(role);
      const original = String(safeReadFile(filePath, { encoding: 'utf8' }) || '');
      expect(original).toContain('name: kyberion-implementer');

      withExecutionContext('generate_subagent_definitions', () => {
        safeWriteFile(filePath, `${original}\n<!-- tampered -->\n`);
      });

      process.exitCode = undefined;
      await main(['--check']);
      expect(process.exitCode).toBe(1);

      withExecutionContext('generate_subagent_definitions', () => {
        safeWriteFile(filePath, original);
      });
      process.exitCode = undefined;
      await main(['--check']);
      expect(process.exitCode).toBeUndefined();
    });
  });
});
