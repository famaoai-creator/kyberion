import { logger, safeReadFile, safeWriteFile, pathResolver, parseData, stringifyData, safeMkdir } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { execSync } from 'node:child_process';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

/**
 * Modeling-Actuator v1.3.0 [INTELLIGENT ANALYSIS & MODELING]
 * Unified interface for schema validation, strategic modeling, and codebase analysis.
 */

interface ModelingAction {
  action: 'validate' | 'simulate' | 'optimize' | 'analyze' | 'graph' | 'parse_nonfunctional';
  schemaPath?: string;
  // ... rest of interface
  dataPath?: string;
  model?: 'unit_economics' | 'financial_projection' | 'risk_scoring';
  analysisType?: 'skill_cooccurrence' | 'context_ranking' | 'knowledge_graph';
  intent?: string;
  limit?: number;
  data?: any;
}

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);

async function handleAction(input: ModelingAction) {
  switch (input.action) {
    case 'validate':
      return await performValidation(input);
    case 'analyze':
      return await performAnalysis(input);
    case 'graph':
      return await performGraphGeneration(input);
    case 'parse_nonfunctional':
      return await performNonFunctionalParsing(input);
    case 'simulate':
    case 'optimize':
    default:
      logger.info(`📊 [MODELING] Running ${input.model || input.action} engine...`);
      return { status: 'success', result: {} };
  }
}

async function performValidation(input: ModelingAction) {
  if (!input.schemaPath || !input.dataPath) {
    throw new Error('Missing schemaPath or dataPath for validation.');
  }
  logger.info(`🧪 Validating data: ${input.dataPath} against ${input.schemaPath}`);
  
  const schemaStr = safeReadFile(path.resolve(process.cwd(), input.schemaPath), { encoding: 'utf8' }) as string;
  const dataStr = safeReadFile(path.resolve(process.cwd(), input.dataPath), { encoding: 'utf8' }) as string;
  
  const validate = ajv.compile(JSON.parse(schemaStr));
  const valid = validate(JSON.parse(dataStr));
  
  if (!valid) {
    logger.error(`❌ Validation FAILED for ${input.dataPath}`);
    return { valid: false, errors: validate.errors };
  }
  
  logger.success(`✅ Validation PASSED for ${input.dataPath}`);
  return { valid: true };
}

async function performAnalysis(input: ModelingAction) {
  const { analysisType } = input;
  logger.info(`🔍 [ANALYSIS] Running ${analysisType}...`);

  switch (analysisType) {
    case 'skill_cooccurrence':
      return analyzeSkillCooccurrence();
    case 'context_ranking':
      return analyzeContextRanking(input.intent || '', input.limit || 7);
    case 'knowledge_graph':
      return analyzeKnowledgeGraph();
    default:
      throw new Error(`Unsupported analysis type: ${analysisType}`);
  }
}

function analyzeSkillCooccurrence() {
  const pipelineDir = path.join(process.cwd(), 'pipelines');
  if (!fs.existsSync(pipelineDir)) return { status: 'skipped', reason: 'No pipeline directory' };

  const pipelines = fs.readdirSync(pipelineDir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
  const graph: Record<string, Set<string>> = {};

  pipelines.forEach((file) => {
    try {
      const content = fs.readFileSync(path.join(pipelineDir, file), 'utf8');
      const def = parseData(content, 'yaml');
      if (def.steps && Array.isArray(def.steps)) {
        const skillsInPipeline = def.steps.map((step: any) => step.skill).filter(Boolean);
        skillsInPipeline.forEach((skill: string) => {
          if (!graph[skill]) graph[skill] = new Set();
          skillsInPipeline.forEach((related: string) => {
            if (skill !== related) graph[skill].add(related);
          });
        });
      }
    } catch (_) {}
  });

  const updatedSkills: string[] = [];
  for (const [skill, relatedSet] of Object.entries(graph)) {
    const skillFullDir = pathResolver.skillDir(skill);
    if (!skillFullDir) continue;

    const skillMdPath = path.join(skillFullDir, 'SKILL.md');
    if (fs.existsSync(skillMdPath)) {
      const content = safeReadFile(skillMdPath, { encoding: 'utf8' }) as string;
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/m);
      if (fmMatch) {
        try {
          const fm = parseData(fmMatch[1], 'yaml');
          const related = Array.from(relatedSet).sort();
          if (JSON.stringify(fm.related_skills) !== JSON.stringify(related)) {
            fm.related_skills = related;
            const newFm = stringifyData(fm, 'yaml').trim();
            const newContent = content.replace(/^---\n[\s\S]*?\n---/m, `---\n${newFm}\n---`);
            safeWriteFile(skillMdPath, newContent);
            updatedSkills.push(skill);
          }
        } catch (_) {}
      }
    }
  }
  return { status: 'success', updated_skills: updatedSkills };
}

function analyzeContextRanking(intent: string, limit: number) {
  const indexPath = pathResolver.knowledge('orchestration/knowledge_index.json');
  const activeMission = detectActiveMission();
  const visionItem = activeMission ? getVisionContext(activeMission) : null;
  const projectWorkflows = activeMission ? getProjectWorkflows(activeMission) : [];
  const activeRole = getActiveRole();

  if (!fs.existsSync(indexPath)) {
    const defaults = visionItem ? [visionItem, ...projectWorkflows] : projectWorkflows;
    return { status: 'warning', reason: 'Knowledge index not found', top_matches: defaults.slice(0, limit) };
  }

  try {
    const indexContent = safeReadFile(indexPath, { encoding: 'utf8' }) as string;
    const index = JSON.parse(indexContent);
    const query = intent.toLowerCase();
    const queryWords = query.split(/[\s,._/-]+/).filter(w => w.length > 2);

    const scoredItems = index.items.map((item: any) => {
      let score = 0;
      const title = (item.title || '').toLowerCase();
      const id = (item.id || '').toLowerCase();
      const cat = (item.category || '').toLowerCase();
      const tags = (item.tags || []).map((t: string) => t.toLowerCase());
      const roles = (item.related_roles || []).map((r: string) => r.toLowerCase());

      queryWords.forEach(word => {
        if (title.includes(word)) score += 10;
        if (id.includes(word)) score += 5;
        if (cat.includes(word)) score += 3;
        if (tags.some((t: string) => t.includes(word))) score += 15;
      });

      if (query.includes(cat) || cat.includes(query)) score += 15;
      if (activeRole && roles.some((r: string) => r.includes(activeRole.toLowerCase()))) score += 25;
      if (item.importance) score += (item.importance * 3);
      if (item.last_updated && item.last_updated.startsWith('2026')) score += 2;
      return { ...item, score };
    });

    const priorityItems = visionItem ? [visionItem, ...projectWorkflows] : projectWorkflows;
    const ranked = scoredItems
      .filter((item: any) => item.score > 0)
      .sort((a: any, b: any) => b.score - a.score)
      .slice(0, limit - priorityItems.length);

    const finalMatches = [...priorityItems, ...ranked];
    const activeContextPath = pathResolver.knowledge('orchestration/active_context.json');
    safeWriteFile(activeContextPath, JSON.stringify({ intent, timestamp: new Date().toISOString(), top_matches: finalMatches }, null, 2));

    return { status: 'success', intent, top_matches: finalMatches };
  } catch (err: any) {
    return { status: 'failed', error: err.message };
  }
}

function analyzeKnowledgeGraph() {
  const knowledgeDir = path.join(process.cwd(), 'knowledge');
  const ecoMapPath = path.join(knowledgeDir, 'Ecosystem_Map.md');

  function walk(dir: string, fileList: string[] = []): string[] {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const filePath = path.join(dir, file);
      if (fs.statSync(filePath).isDirectory()) {
        if (!['node_modules', '.git', 'dist'].includes(file)) walk(filePath, fileList);
      } else if (file.endsWith('.md') && !['README.md', '_index.md', 'Ecosystem_Map.md'].includes(file)) {
        fileList.push(filePath);
      }
    }
    return fileList;
  }

  const files = walk(knowledgeDir);
  const docs: any[] = [];

  files.forEach(file => {
    const content = fs.readFileSync(file, 'utf8');
    const titleMatch = content.match(/^# (.*)/m);
    docs.push({ id: path.relative(knowledgeDir, file), title: titleMatch ? titleMatch[1].trim() : path.basename(file, '.md'), absPath: file, links: [] });
  });

  docs.forEach(source => {
    const content = fs.readFileSync(source.absPath, 'utf8');
    docs.forEach(target => {
      if (source.id !== target.id && (content.includes(target.title) || content.includes(target.id))) {
        source.links.push(target.title);
      }
    });
  });

  let mermaid = '```mermaid\ngraph TD\n';
  docs.forEach(doc => {
    const sanitizedId = doc.id.replace(/\//g, '_').replace(/\./g, '_').replace(/-/g, '_');
    mermaid += `    ${sanitizedId}["${doc.title.substring(0, 30)}"]\n`;
    doc.links.forEach((link: string) => {
      const target = docs.find(d => d.title === link);
      if (target) {
        const targetId = target.id.replace(/\//g, '_').replace(/\./g, '_').replace(/-/g, '_');
        mermaid += `    ${sanitizedId} --> ${targetId}\n`;
      }
    });
  });
  mermaid += '```\n';

  const ecoMapContent = `# Ecosystem Knowledge Map\n\nAutomatically generated graph of knowledge relationships.\n\n${mermaid}`;
  safeWriteFile(ecoMapPath, ecoMapContent);

  docs.forEach(doc => {
    if (doc.links.length > 0 && doc.id.startsWith('architecture/')) {
      let content = fs.readFileSync(doc.absPath, 'utf8');
      if (!content.includes('## 🔗 Related Knowledge')) {
        content += `\n\n## 🔗 Related Knowledge\n${doc.links.map((l: string) => `- ${l}`).join('\n')}\n`;
        safeWriteFile(doc.absPath, content);
      }
    }
  });

  return { status: 'success', path: ecoMapPath };
}

// Helpers for context ranking
function getActiveRole(): string | null {
  try {
    const sessionPath = path.join(pathResolver.rootDir(), 'active/shared/governance/session.json');
    if (fs.existsSync(sessionPath)) {
      const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
      return session.active_role || null;
    }
  } catch (_) {}
  return null;
}

function detectActiveMission(): string | null {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();
    if (branch.startsWith('mission/')) return branch.replace('mission/', '').toUpperCase();
  } catch (_) {}
  return process.env.MISSION_ID || null;
}

function getVisionContext(missionId: string) {
  try {
    const missionDir = pathResolver.missionDir(missionId);
    const statePath = path.join(missionDir, 'mission-state.json');
    if (fs.existsSync(statePath)) {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (state.vision_ref && fs.existsSync(path.join(pathResolver.rootDir(), state.vision_ref))) {
        return { id: 'vision_context', title: `Vision: ${state.tenant_id}`, category: 'Vision', score: 100 };
      }
    }
  } catch (_) {}
  return null;
}

function getProjectWorkflows(missionId: string) {
  const items: any[] = [];
  try {
    const missionDir = pathResolver.missionDir(missionId);
    const statePath = path.join(missionDir, 'mission-state.json');
    if (fs.existsSync(statePath)) {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      (state.context?.associated_projects || []).forEach((proj: string) => {
        const workflowPath = pathResolver.active(`projects/${proj}/WORKFLOW.md`);
        if (fs.existsSync(workflowPath)) items.push({ id: `workflow_${proj}`, title: `Workflow: ${proj}`, category: 'Project Workflow', score: 95 });
      });
    }
  } catch (_) {}
  return items;
}

async function performGraphGeneration(_input: ModelingAction) {
  const indexPath = pathResolver.knowledge('orchestration/global_skill_index.json');
  const outputPath = path.resolve(process.cwd(), 'docs/architecture/dependency-graph.mmd');
  if (!fs.existsSync(indexPath)) return { status: 'failed', reason: 'No index' };

  const index = JSON.parse(safeReadFile(indexPath, { encoding: 'utf8' }) as string);
  const skills = index.s || [];

  let mermaid = 'graph TD\n  subgraph Ecosystem ["Gemini Skills Ecosystem"]\n';
  const namespaces: Record<string, string[]> = {};
  
  skills.forEach((s: any) => {
    const parts = s.path.split('/');
    const cat = parts.length > 1 ? parts[1] : 'General';
    if (!namespaces[cat]) namespaces[cat] = [];
    namespaces[cat].push(s.n);
  });

  Object.keys(namespaces).sort().forEach(ns => {
    mermaid += `    subgraph ${ns} ["📂 ${ns.toUpperCase()}"]\n`;
    namespaces[ns].forEach(skill => {
      mermaid += `      ${skill.replace(/-/g, '_')}["${skill}"]\n`;
    });
    mermaid += '    end\n';
  });
  mermaid += '  end\n';

  if (!fs.existsSync(path.dirname(outputPath))) safeMkdir(path.dirname(outputPath), { recursive: true });
  safeWriteFile(outputPath, mermaid);
  return { status: 'success', graph_path: outputPath };
}

async function performNonFunctionalParsing(input: ModelingAction) {
  const data = input.data || {};
  logger.info(`📝 [MODELING] Parsing non-functional requirements to ADF...`);
  const adf = { type: 'non-functional', requirements: data };
  return { status: 'success', adf };
}

const main = async () => {
  const argv = await createStandardYargs().option('input', { alias: 'i', type: 'string', required: true }).parseSync();
  const inputContent = safeReadFile(path.resolve(process.cwd(), argv.input as string), { encoding: 'utf8' }) as string;
  const result = await handleAction(JSON.parse(inputContent));
  console.log(JSON.stringify(result, null, 2));
};

if (require.main === module) {
  main().catch(err => {
    logger.error(err.message);
    process.exit(1);
  });
}
