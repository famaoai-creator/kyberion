import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync, safeSymlinkSync, safeWriteFile } from './secure-io.js';
import {
  loadSkillResourceDescriptor,
  readSkillResourceForModel,
  readSkillResourceBody,
  resolveSkillToolSurface,
  renderSkillResourceIndex,
} from './skill-resource-loader.js';

const root = `active/shared/tmp/skill-resource-loader-${process.pid}`;

afterEach(() => {
  safeRmSync(pathResolver.rootResolve(root), { recursive: true, force: true });
});

describe('PI-09 skill progressive disclosure', () => {
  it('exposes metadata in the index but keeps the body out', () => {
    const dir = pathResolver.rootResolve(`${root}/demo`);
    safeMkdir(dir, { recursive: true });
    safeWriteFile(
      `${dir}/SKILL.md`,
      [
        '---',
        'name: demo-skill',
        'description: A governed demo skill',
        'disable-model-invocation: true',
        'allowed-tools: Read, Grep',
        '---',
        '',
        '# Private implementation body',
      ].join('\n')
    );

    const descriptor = loadSkillResourceDescriptor(`${root}/demo`);
    const index = renderSkillResourceIndex([descriptor]);
    expect(index).toContain('demo-skill');
    expect(index).toContain('A governed demo skill');
    expect(index).not.toContain('Private implementation body');
    expect(descriptor.frontmatter.allowed_tools).toEqual(['Read', 'Grep']);
    expect(descriptor.provenance.scope).toBe('temporary');
    expect(() => readSkillResourceBody(descriptor, 'model')).toThrow(
      '[SKILL_MODEL_INVOCATION_DISABLED]'
    );
    expect(readSkillResourceBody(descriptor, 'explicit')).toContain('Private implementation body');
  });

  it('projects allowed-tools into a role-filtered minimal active set plus deferred tools', () => {
    const descriptor = {
      name: 'tool-aware-skill',
      description: 'Tool-aware skill',
      path: `${root}/tool-aware/SKILL.md`,
      frontmatter: {
        name: 'tool-aware-skill',
        description: 'Tool-aware skill',
        disable_model_invocation: false,
        allowed_tools: ['tool_search', 'search', 'write'],
      },
      provenance: {
        source: 'test',
        scope: 'temporary' as const,
        origin: 'generated' as const,
        base_dir: `${root}/tool-aware`,
        trust: 'untrusted' as const,
      },
    };
    const catalog = [
      {
        name: 'tool_search',
        description: 'Search tools',
        inputSchema: { type: 'object', properties: {} },
        allowed_roles: ['agent'],
      },
      {
        name: 'search',
        description: 'Search content',
        inputSchema: { type: 'object', properties: {} },
        allowed_roles: ['agent'],
      },
      {
        name: 'write',
        description: 'Write content',
        inputSchema: { type: 'object', properties: {} },
        allowed_roles: ['agent'],
      },
    ];

    const plan = resolveSkillToolSurface(descriptor, catalog, { role: 'agent' });
    expect(plan.active.map((tool) => tool.name)).toEqual(['tool_search']);
    expect(plan.deferred.map((tool) => tool.name)).toEqual(['search', 'write']);
    expect(plan.announcement).toContain('search');
  });

  it('rejects a skill frontmatter tool that is absent from the governed catalog', () => {
    const descriptor = {
      name: 'broken-tool-skill',
      description: 'Broken tool skill',
      path: `${root}/broken-tool/SKILL.md`,
      frontmatter: {
        name: 'broken-tool-skill',
        description: 'Broken tool skill',
        disable_model_invocation: false,
        allowed_tools: ['missing_tool'],
      },
      provenance: {
        source: 'test',
        scope: 'temporary' as const,
        origin: 'generated' as const,
        base_dir: `${root}/broken-tool`,
        trust: 'untrusted' as const,
      },
    };
    expect(() => resolveSkillToolSurface(descriptor, [])).toThrow('[SKILL_TOOL_UNKNOWN]');
  });

  it('requires an explicit scoped model read and returns an auditable receipt', () => {
    const dir = pathResolver.rootResolve(`${root}/audited`);
    safeMkdir(dir, { recursive: true });
    safeWriteFile(
      `${dir}/SKILL.md`,
      ['---', 'name: audited-skill', 'description: Audited skill', '---', '', 'Body'].join('\n')
    );
    const descriptor = loadSkillResourceDescriptor(`${root}/audited`);
    const result = readSkillResourceForModel(descriptor, {
      missionPath: pathResolver.rootResolve(`${root}/mission`),
      missionId: 'MSN-SKILL-READ',
      taskId: 'TASK-SKILL-READ',
      scope: { tier: 'public', mission_id: 'MSN-SKILL-READ' },
    });
    expect(result.body).toBe('Body');
    expect(result.promptVisibilityRecord).toMatchObject({
      mission_id: 'MSN-SKILL-READ',
      task_id: 'TASK-SKILL-READ',
      form: 'skill_body',
      knowledge_refs: [descriptor.path],
    });
  });

  it('applies the governed restricted-skills consumer before returning the body', () => {
    const dir = pathResolver.rootResolve(`${root}/restricted`);
    safeMkdir(dir, { recursive: true });
    safeWriteFile(
      `${dir}/SKILL.md`,
      [
        '---',
        'name: mock-malicious-skill',
        'description: Restricted fixture',
        '---',
        '',
        'must not be returned',
      ].join('\n')
    );
    const descriptor = loadSkillResourceDescriptor(`${root}/restricted`);
    expect(() =>
      readSkillResourceForModel(descriptor, {
        missionPath: pathResolver.rootResolve(`${root}/mission`),
        missionId: 'MSN-RESTRICTED-SKILL',
        scope: { tier: 'public', mission_id: 'MSN-RESTRICTED-SKILL' },
      })
    ).toThrow('[SKILL_RESOURCE_RESTRICTED] mock-malicious-skill');
  });

  it('rejects reads without a valid mission scope before policy evaluation', () => {
    const dir = pathResolver.rootResolve(`${root}/scope-required`);
    safeMkdir(dir, { recursive: true });
    safeWriteFile(
      `${dir}/SKILL.md`,
      ['---', 'name: scoped-skill', 'description: Scoped skill', '---', '', 'Body'].join('\n')
    );
    const descriptor = loadSkillResourceDescriptor(`${root}/scope-required`);
    expect(() =>
      readSkillResourceForModel(descriptor, {
        missionPath: pathResolver.rootResolve(`${root}/mission`),
        missionId: 'MSN-SCOPE-REQUIRED',
        scope: { tier: 'public', mission_id: 'MSN-DIFFERENT' },
      })
    ).toThrow('[SKILL_SCOPE_MISMATCH]');
  });

  it('rejects a skill without required metadata', () => {
    const dir = pathResolver.rootResolve(`${root}/invalid`);
    safeMkdir(dir, { recursive: true });
    safeWriteFile(`${dir}/SKILL.md`, '# no metadata');
    expect(() => loadSkillResourceDescriptor(`${root}/invalid`)).toThrow(
      '[SKILL_RESOURCE_INVALID] missing frontmatter'
    );
  });

  it('rejects a SKILL.md directory before attempting to read it', () => {
    const dir = pathResolver.rootResolve(`${root}/directory-resource`);
    safeMkdir(pathResolver.rootResolve(`${root}/directory-resource/SKILL.md`), { recursive: true });
    expect(() => loadSkillResourceDescriptor(dir)).toThrow(
      '[SKILL_RESOURCE_INVALID] skill resource must be a regular file'
    );
  });

  it('does not inspect project-local skills before trust resolution', () => {
    expect(() =>
      loadSkillResourceDescriptor('skills/project-local', undefined, { trustResolved: false })
    ).toThrow('[TRUST_REQUIRED]');
  });

  it('fails closed when project trust is omitted', () => {
    expect(() => loadSkillResourceDescriptor('skills/project-local')).toThrow('[TRUST_REQUIRED]');
  });

  it('rejects repository escape and symbolic-link traversal before loading', () => {
    expect(() => loadSkillResourceDescriptor('../package')).toThrow('[SKILL_RESOURCE_SCOPE]');

    const outside = pathResolver.rootResolve(`${root}/outside`);
    const link = pathResolver.rootResolve(`${root}/linked`);
    safeMkdir(outside, { recursive: true });
    safeWriteFile(
      pathResolver.rootResolve(`${root}/outside/SKILL.md`),
      ['---', 'name: linked', 'description: linked', '---', '', 'Body'].join('\n')
    );
    safeSymlinkSync(outside, link);
    expect(() => loadSkillResourceDescriptor(`${root}/linked`)).toThrow('[SKILL_RESOURCE_SCOPE]');
  });

  it('rechecks trust when a caller supplies a descriptor directly', () => {
    const descriptor = {
      name: 'project-local',
      description: 'Project-local skill',
      path: pathResolver.rootResolve('skills/project-local/SKILL.md'),
      frontmatter: {
        name: 'project-local',
        description: 'Project-local skill',
        disable_model_invocation: false,
        allowed_tools: [],
      },
      provenance: {
        source: 'test',
        scope: 'repository' as const,
        origin: 'builtin' as const,
        base_dir: pathResolver.rootResolve('skills/project-local'),
        trust: 'trusted' as const,
      },
    };
    expect(() => readSkillResourceBody(descriptor)).toThrow('[TRUST_REQUIRED]');
  });
});
