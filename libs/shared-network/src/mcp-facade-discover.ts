/**
 * MCP facade — discover band: transferable Kyberion skill tools/resources.
 *
 * Extracted from mcp-server-engine.ts (kyberion.skill.list / .get and the
 * kyberion-skill MCP Resource) so the engine stays under the max-file-lines
 * gate. The engine still owns registration/governance plumbing
 * (registerGovernedTool) and injects it here — see
 * knowledge/product/architecture/mcp-facade-model.md for the band model.
 */
import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { resolveMcpRequestContext } from '@agent/core/mcp-request-context';
import { resolveScopeResolution } from '@agent/core/scope-context';
import { formatWireError } from '@agent/core/wire-error';
import {
  getTransferableSkill,
  listTransferableSkills,
  parseSkillResourceUri,
  readTransferableSkillBody,
} from './mcp-skill-transfer.js';
import type { RegisterGovernedTool, ToolCatalog } from './mcp-server-engine.js';

/** Register the discover-band skill tools and MCP resource on `server`. */
export function registerMcpFacadeDiscoverTools(params: {
  server: McpServer;
  catalog: ToolCatalog;
  registerGovernedTool: RegisterGovernedTool;
}): void {
  const { server, catalog, registerGovernedTool } = params;

  // ── kyberion.scope.current ────────────────────────────────────────────────
  registerGovernedTool(
    server,
    catalog,
    'kyberion.scope.current',
    'Resolve the effective Kyberion scope, its provenance, and the positive knowledge roots available to this process.',
    {},
    async () => {
      const context = resolveMcpRequestContext();
      const scopeInput = {
        tier: context.scope.tier,
        ...(context.scope.tenant_slug ? { tenant_slug: context.scope.tenant_slug } : {}),
        ...(context.scope.organization_id
          ? { organization_id: context.scope.organization_id }
          : {}),
        ...(context.scope.project_id ? { project_id: context.scope.project_id } : {}),
        ...(context.scope.mission_id ? { mission_id: context.scope.mission_id } : {}),
        ...(context.scope.task_id ? { task_id: context.scope.task_id } : {}),
      };
      const resolution = resolveScopeResolution(
        scopeInput,
        {
          KYBERION_TIER: context.scope.tier,
          KYBERION_TENANT: context.scope.tenant_slug,
          KYBERION_ORGANIZATION_ID: context.scope.organization_id,
          KYBERION_PROJECT_ID: context.scope.project_id,
          MISSION_ID: context.scope.mission_id,
          KYBERION_TASK_ID: context.scope.task_id,
        },
        { includePersisted: false, inferFromMission: false, inferFromCwd: false }
      );
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(resolution, null, 2) }],
      };
    }
  );

  // ── kyberion.skill.list / .get (discover band — transferable SKILL.md) ────
  registerGovernedTool(
    server,
    catalog,
    'kyberion.skill.list',
    'List transferable first-party Kyberion skills (SKILL.md) for MCP clients.',
    {
      plugin_id: z
        .string()
        .optional()
        .describe('Optional plugin id filter (e.g. kyberion, kyberion-agent-plugin)'),
    },
    async ({ plugin_id }) => {
      try {
        let skills = listTransferableSkills();
        if (typeof plugin_id === 'string' && plugin_id.trim()) {
          const needle = plugin_id.trim();
          skills = skills.filter((skill) => skill.plugin_id === needle);
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  skills: skills.map(({ plugin_id: p, skill_id, title, description, uri }) => ({
                    plugin_id: p,
                    skill_id,
                    title,
                    description,
                    uri,
                  })),
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: formatWireError(err, 'Failed to list transferable skills'),
            },
          ],
          isError: true,
        };
      }
    }
  );

  registerGovernedTool(
    server,
    catalog,
    'kyberion.skill.get',
    'Fetch a transferable skill body (SKILL.md) by plugin_id and skill_id.',
    {
      plugin_id: z.string().min(1).describe('Plugin id (e.g. kyberion)'),
      skill_id: z.string().min(1).describe('Skill id (often same as plugin_id for root SKILL.md)'),
    },
    async ({ plugin_id, skill_id }) => {
      try {
        const skill = getTransferableSkill(plugin_id, skill_id);
        if (!skill) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Skill not found: ${plugin_id}/${skill_id}`,
              },
            ],
            isError: true,
          };
        }
        const body = readTransferableSkillBody(skill);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  plugin_id: skill.plugin_id,
                  skill_id: skill.skill_id,
                  title: skill.title,
                  description: skill.description,
                  uri: skill.uri,
                  mime_type: 'text/markdown',
                  body,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: formatWireError(err, 'Failed to get transferable skill'),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ── MCP Resources: transferable skills ────────────────────────────────────
  server.registerResource(
    'kyberion-skill',
    new ResourceTemplate('kyberion://skill/{plugin}/{skill}', {
      list: async () => ({
        resources: listTransferableSkills().map((skill) => ({
          uri: skill.uri,
          name: `${skill.plugin_id}/${skill.skill_id}`,
          description: skill.description || skill.title,
          mimeType: 'text/markdown',
        })),
      }),
    }),
    {
      description: 'First-party transferable Kyberion SKILL.md guides',
      mimeType: 'text/markdown',
    },
    async (uri, variables) => {
      const plugin =
        typeof variables.plugin === 'string'
          ? variables.plugin
          : Array.isArray(variables.plugin)
            ? String(variables.plugin[0] ?? '')
            : '';
      const skillId =
        typeof variables.skill === 'string'
          ? variables.skill
          : Array.isArray(variables.skill)
            ? String(variables.skill[0] ?? '')
            : '';
      const fromUri = parseSkillResourceUri(uri.href);
      const pluginId = plugin || fromUri?.plugin_id || '';
      const resolvedSkillId = skillId || fromUri?.skill_id || '';
      const skill = getTransferableSkill(pluginId, resolvedSkillId);
      if (!skill) {
        throw new Error(`Skill resource not found: ${uri.href}`);
      }
      return {
        contents: [
          {
            uri: skill.uri,
            mimeType: 'text/markdown',
            text: readTransferableSkillBody(skill),
          },
        ],
      };
    }
  );
}
