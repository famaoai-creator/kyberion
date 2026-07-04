import type { A2AMessage } from './a2a-bridge.js';
import type { A2UIMessage } from './a2ui.js';
import type {
  MissionProposal,
  NerveRoutingProposal,
  PlanningPacket,
  SlackApprovalRequestDraft,
  SurfaceConversationResult,
} from './channel-surface-types.js';
import { extractPlanningPacketBlocks } from './planning-packet-contract.js';
import { extractTaskResultBlocks } from './task-result-contract.js';

const REASONING_TAG_NAMES = [
  'think',
  'thinking',
  'reasoning',
  'thought',
  'REASONING_SCRATCHPAD',
] as const;
const REASONING_FENCE_LANGS = new Set(['thought', 'reasoning', 'internal']);

function stripReasoningPairsFromLine(line: string): string {
  let text = line;
  for (const tag of REASONING_TAG_NAMES) {
    const pairRegex = new RegExp(`<\\s*${tag}\\s*>[\\s\\S]*?<\\/\\s*${tag}\\s*>`, 'gi');
    text = text.replace(pairRegex, '');
  }
  return text;
}

function stripReasoningTags(input: string): string {
  if (!input || input.indexOf('<') === -1) return input;

  const lines = input.split(/\r?\n/);
  const output: string[] = [];
  let inReasoningBlock = false;
  let fenceLanguage = '';

  for (const rawLine of lines) {
    let line = rawLine;
    const fenceMatch = line.trimEnd().match(/^```([a-z0-9_-]+)?\s*$/i);
    if (fenceMatch) {
      const language = (fenceMatch[1] || '').toLowerCase();
      if (!inReasoningBlock && REASONING_FENCE_LANGS.has(language)) {
        inReasoningBlock = true;
        fenceLanguage = language;
        continue;
      }
      if (inReasoningBlock && (!fenceLanguage || fenceLanguage === language)) {
        inReasoningBlock = false;
        fenceLanguage = '';
        continue;
      }
    }

    if (inReasoningBlock) {
      const closeTagMatch = line.match(
        /<\/\s*(think|thinking|reasoning|thought|REASONING_SCRATCHPAD)\s*>/i
      );
      if (!closeTagMatch || closeTagMatch.index === undefined) {
        continue;
      }
      line = line.slice(closeTagMatch.index + closeTagMatch[0].length);
      inReasoningBlock = false;
      fenceLanguage = '';
      line = stripReasoningPairsFromLine(line);
      if (!line.trim()) continue;
    }

    line = stripReasoningPairsFromLine(line);
    if (!line.trim()) continue;

    const openBoundary = line.match(
      /^\s*<\s*(think|thinking|reasoning|thought|REASONING_SCRATCHPAD)\s*>/i
    );
    if (openBoundary) {
      const afterOpen = line.slice(openBoundary[0].length);
      const closeRegex = new RegExp(`</\\s*${openBoundary[1]}\\s*>`, 'i');
      const closeMatch = closeRegex.exec(afterOpen);
      if (closeMatch && closeMatch.index !== undefined) {
        line = afterOpen.slice(closeMatch.index + closeMatch[0].length);
      } else {
        inReasoningBlock = true;
        fenceLanguage = '';
        continue;
      }
    }

    if (line.trim()) {
      output.push(line);
    } else if (output.length > 0 && output[output.length - 1] !== '') {
      output.push('');
    }
  }

  return output.join('\n');
}

function sanitizeSurfaceReplyText(input: string): string {
  const lines = stripReasoningTags(input).split(/\r?\n/);
  const sanitized: string[] = [];
  let skippingFence = false;
  let fenceLanguage = '';

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const fenceMatch = line.match(/^```([a-z0-9_-]+)?\s*$/i);
    if (fenceMatch) {
      const language = (fenceMatch[1] || '').toLowerCase();
      if (!skippingFence && ['thought', 'analysis', 'reasoning', 'internal'].includes(language)) {
        skippingFence = true;
        fenceLanguage = language;
        continue;
      }
      if (skippingFence && (!fenceLanguage || fenceLanguage === language)) {
        skippingFence = false;
        fenceLanguage = '';
        continue;
      }
    }

    if (skippingFence) continue;

    const normalized = line.trim();
    const boilerplatePatterns = [
      /^\*\*responding to a user\*\*$/i,
      /^\*\*thinking\*\*$/i,
      /^i['’]m processing the request internally\.$/i,
      /^i am processing the request internally\.$/i,
      /^i['’]m thinking about the request internally\.$/i,
      /^i am thinking about the request internally\.$/i,
    ];
    if (boilerplatePatterns.some((pattern) => pattern.test(normalized))) {
      continue;
    }

    sanitized.push(rawLine);
  }

  return sanitized.join('\n').trim();
}

export function extractSurfaceBlocks(raw: string): SurfaceConversationResult {
  const a2uiMessages: A2UIMessage[] = [];
  const a2aMessages: A2AMessage[] = [];
  const approvalRequests: SlackApprovalRequestDraft[] = [];
  const routingProposals: NerveRoutingProposal[] = [];
  const missionProposals: MissionProposal[] = [];
  const surfaceParseErrors: string[] = [];

  let text = raw;
  const planningPacketBlocks = extractPlanningPacketBlocks(text);
  text = planningPacketBlocks.text;
  const taskResultBlocks = extractTaskResultBlocks(text);
  text = taskResultBlocks.text;

  text = text.replace(/```a2ui\s*\n([\s\S]*?)```/g, (_match, json) => {
    try {
      a2uiMessages.push(JSON.parse(json.trim()) as A2UIMessage);
    } catch (error: any) {
      surfaceParseErrors.push(`a2ui block parse failed: ${error?.message ?? String(error)}`);
    }
    return '';
  });

  text = text.replace(/```\s*a2ui\s*\n([\s\S]*?)```/g, (_match, json) => {
    try {
      a2uiMessages.push(JSON.parse(json.trim()) as A2UIMessage);
    } catch (error: any) {
      surfaceParseErrors.push(`a2ui block parse failed: ${error?.message ?? String(error)}`);
    }
    return '';
  });

  text = text.replace(/```a2a\s*\n([\s\S]*?)```/g, (_match, json) => {
    try {
      a2aMessages.push(JSON.parse(json.trim()) as A2AMessage);
    } catch (error: any) {
      surfaceParseErrors.push(`a2a block parse failed: ${error?.message ?? String(error)}`);
    }
    return '';
  });

  text = text.replace(/```approval\s*\n([\s\S]*?)```/g, (_match, json) => {
    try {
      approvalRequests.push(JSON.parse(json.trim()));
    } catch (error: any) {
      surfaceParseErrors.push(`approval block parse failed: ${error?.message ?? String(error)}`);
    }
    return '';
  });

  text = text.replace(/```(?:nerve_route|route)\s*\n([\s\S]*?)```/g, (_match, json) => {
    try {
      routingProposals.push(JSON.parse(json.trim()) as NerveRoutingProposal);
    } catch (error: any) {
      surfaceParseErrors.push(`routing proposal parse failed: ${error?.message ?? String(error)}`);
    }
    return '';
  });

  text = text.replace(/```mission_proposal\s*\n([\s\S]*?)```/g, (_match, json) => {
    try {
      missionProposals.push(JSON.parse(json.trim()) as MissionProposal);
    } catch (error: any) {
      surfaceParseErrors.push(`mission proposal parse failed: ${error?.message ?? String(error)}`);
    }
    return '';
  });

  text = text.replace(/>>A2A(\{[\s\S]*?\})<</g, (_match, json) => {
    try {
      a2aMessages.push(JSON.parse(json.trim()) as A2AMessage);
    } catch (error: any) {
      surfaceParseErrors.push(`a2a legacy block parse failed: ${error?.message ?? String(error)}`);
    }
    return '';
  });

  text = sanitizeSurfaceReplyText(text);

  return {
    text: text.trim(),
    a2uiMessages,
    a2aMessages,
    delegationResults: [],
    approvalRequests,
    routingProposals,
    missionProposals,
    planningPackets: planningPacketBlocks.planningPackets,
    taskResults: taskResultBlocks.taskResults,
    taskResultErrors: taskResultBlocks.taskResultErrors,
    surfaceParseErrors,
  };
}

export { sanitizeSurfaceReplyText };
