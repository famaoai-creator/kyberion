import type { A2AMessage } from './a2a-bridge.js';
import type { A2UIComponent, A2UIMessage } from './a2ui.js';
import type {
  MissionProposal,
  NerveRoutingProposal,
  SlackApprovalRequestDraft,
  SurfaceConversationResult,
} from './channel-surface-types.js';
import { extractPlanningPacketBlocks } from './planning-packet-contract.js';
import { extractTaskResultBlocks } from './task-result-contract.js';
import { parseSafeJsonInput } from './foundation/safe-json.js';

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return value === undefined ? undefined : typeof value === 'string' ? value : undefined;
}

const A2UI_COMPONENT_TYPES = new Set([
  'text',
  'button',
  'card',
  'container',
  'display:hero',
  'display:badges',
  'display:section',
  'display:gauge',
  'display:log',
  'display:table',
  'display:status',
  'display:kv',
  'display:metric',
  'display:metrics-row',
  'display:timeline',
  'display:progress',
  'display:alert',
  'display:code',
  'display:list',
  'display:card',
  'display:grid',
  'display:donut',
  'display:bar-chart',
  'display:stacked-bar',
  'display:sparkline',
  'kb-layout-grid',
  'kb-status-orbit',
  'kb-mission-card',
  'kb-artifact-tile',
  'kb-intervention-panel',
  'presence.status',
  'presence.subtitle',
  'presence.transcript',
  'presence.avatar',
]);

function normalizeA2UIMessage(value: unknown): A2UIMessage | null {
  if (!isRecord(value)) return null;
  const operations = [
    'createSurface',
    'updateComponents',
    'updateDataModel',
    'deleteSurface',
  ].filter((key) => Object.hasOwn(value, key));
  if (operations.length !== 1) return null;

  if (operations[0] === 'createSurface') {
    const create = value.createSurface;
    if (
      !isRecord(create) ||
      typeof create.surfaceId !== 'string' ||
      typeof create.catalogId !== 'string'
    ) {
      return null;
    }
    const title = optionalString(create, 'title');
    const titleKey = optionalString(create, 'titleKey');
    if (Object.hasOwn(create, 'title') && title === undefined) return null;
    if (Object.hasOwn(create, 'titleKey') && titleKey === undefined) return null;
    return {
      createSurface: {
        surfaceId: create.surfaceId,
        catalogId: create.catalogId,
        ...(title === undefined ? {} : { title }),
        ...(titleKey === undefined ? {} : { titleKey }),
      },
    };
  }

  if (operations[0] === 'updateComponents') {
    const update = value.updateComponents;
    if (
      !isRecord(update) ||
      typeof update.surfaceId !== 'string' ||
      !Array.isArray(update.components)
    ) {
      return null;
    }
    const components: A2UIComponent[] = [];
    for (const candidate of update.components) {
      if (
        !isRecord(candidate) ||
        typeof candidate.id !== 'string' ||
        typeof candidate.type !== 'string' ||
        !A2UI_COMPONENT_TYPES.has(candidate.type)
      ) {
        return null;
      }
      if (!isRecord(candidate.props)) return null;
      if (
        Object.hasOwn(candidate, 'children') &&
        (!Array.isArray(candidate.children) ||
          candidate.children.some((child) => typeof child !== 'string'))
      ) {
        return null;
      }
      components.push({
        id: candidate.id,
        type: candidate.type as A2UIComponent['type'],
        props: candidate.props,
        ...(Array.isArray(candidate.children) ? { children: candidate.children } : {}),
      });
    }
    return { updateComponents: { surfaceId: update.surfaceId, components } };
  }

  if (operations[0] === 'updateDataModel') {
    const update = value.updateDataModel;
    if (!isRecord(update) || typeof update.surfaceId !== 'string' || !isRecord(update.data))
      return null;
    return { updateDataModel: { surfaceId: update.surfaceId, data: update.data } };
  }

  const deletion = value.deleteSurface;
  return isRecord(deletion) && typeof deletion.surfaceId === 'string'
    ? { deleteSurface: { surfaceId: deletion.surfaceId } }
    : null;
}

function normalizeA2AMessage(value: unknown): A2AMessage | null {
  if (!isRecord(value) || !isRecord(value.header) || !isRecord(value.payload)) return null;
  const header = value.header;
  if (Object.hasOwn(value, 'a2a_version') && typeof value.a2a_version !== 'string') return null;
  const performatives = new Set([
    'request',
    'propose',
    'inform',
    'accept',
    'reject',
    'query',
    'result',
  ]);
  if (typeof header.performative !== 'string' || !performatives.has(header.performative))
    return null;
  const stringFields = [
    'msg_id',
    'parent_id',
    'sender',
    'receiver',
    'conversation_id',
    'correlation_id',
    'timestamp',
    'signature',
    'sig_alg',
    'sender_nhi_id',
    'delegation_chain',
  ];
  if (stringFields.some((key) => Object.hasOwn(header, key) && typeof header[key] !== 'string'))
    return null;
  const headerString = (key: string): string | undefined => optionalString(header, key);
  return {
    a2a_version: typeof value.a2a_version === 'string' ? value.a2a_version : '1.0',
    header: {
      msg_id: headerString('msg_id') ?? 'surface-block',
      sender: headerString('sender') ?? 'surface-response',
      performative: header.performative as A2AMessage['header']['performative'],
      ...(headerString('parent_id') === undefined ? {} : { parent_id: headerString('parent_id') }),
      ...(headerString('receiver') === undefined ? {} : { receiver: headerString('receiver') }),
      ...(headerString('conversation_id') === undefined
        ? {}
        : { conversation_id: headerString('conversation_id') }),
      ...(headerString('correlation_id') === undefined
        ? {}
        : { correlation_id: headerString('correlation_id') }),
      ...(headerString('timestamp') === undefined ? {} : { timestamp: headerString('timestamp') }),
      ...(headerString('signature') === undefined ? {} : { signature: headerString('signature') }),
      ...(headerString('sig_alg') === undefined ? {} : { sig_alg: headerString('sig_alg') }),
      ...(headerString('sender_nhi_id') === undefined
        ? {}
        : { sender_nhi_id: headerString('sender_nhi_id') }),
      ...(headerString('delegation_chain') === undefined
        ? {}
        : { delegation_chain: headerString('delegation_chain') }),
    },
    payload: value.payload,
  };
}

function normalizeApprovalRequest(value: unknown): SlackApprovalRequestDraft | null {
  if (!isRecord(value) || typeof value.title !== 'string' || typeof value.summary !== 'string')
    return null;
  const stringFields = ['details'];
  if (stringFields.some((key) => Object.hasOwn(value, key) && typeof value[key] !== 'string'))
    return null;
  if (
    Object.hasOwn(value, 'severity') &&
    !['low', 'medium', 'high'].includes(String(value.severity))
  )
    return null;
  return {
    title: value.title,
    summary: value.summary,
    ...(value.details === undefined ? {} : { details: value.details as string }),
    ...(value.severity === undefined
      ? {}
      : { severity: value.severity as SlackApprovalRequestDraft['severity'] }),
  };
}

function normalizeRoutingProposal(value: unknown): NerveRoutingProposal | null {
  if (!isRecord(value) || value.intent !== 'delegate_task' || typeof value.team_role !== 'string')
    return null;
  for (const key of ['mission_id', 'task_summary', 'why']) {
    if (Object.hasOwn(value, key) && typeof value[key] !== 'string') return null;
  }
  return {
    intent: 'delegate_task',
    team_role: value.team_role,
    ...(value.mission_id === undefined ? {} : { mission_id: value.mission_id as string }),
    ...(value.task_summary === undefined ? {} : { task_summary: value.task_summary as string }),
    ...(value.why === undefined ? {} : { why: value.why as string }),
  };
}

function normalizeMissionProposal(value: unknown): MissionProposal | null {
  if (!isRecord(value) || value.intent !== 'create_mission') return null;
  for (const key of ['mission_type', 'summary', 'assigned_persona', 'vision_ref', 'why']) {
    if (Object.hasOwn(value, key) && typeof value[key] !== 'string') return null;
  }
  if (
    Object.hasOwn(value, 'tier') &&
    !['personal', 'confidential', 'public'].includes(String(value.tier))
  )
    return null;
  return {
    intent: 'create_mission',
    ...(value.mission_type === undefined ? {} : { mission_type: value.mission_type as string }),
    ...(value.summary === undefined ? {} : { summary: value.summary as string }),
    ...(value.assigned_persona === undefined
      ? {}
      : { assigned_persona: value.assigned_persona as string }),
    ...(value.tier === undefined ? {} : { tier: value.tier as MissionProposal['tier'] }),
    ...(value.vision_ref === undefined ? {} : { vision_ref: value.vision_ref as string }),
    ...(value.why === undefined ? {} : { why: value.why as string }),
  };
}

function parseBlock<T>(
  json: string,
  normalize: (value: unknown) => T | null,
  label: string
): T | null {
  try {
    const parsed: unknown = parseSafeJsonInput(json.trim(), `${label} JSON`);
    const normalized = normalize(parsed);
    if (normalized === null) throw new Error('invalid block shape');
    return normalized;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label}: ${message}`);
  }
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
      const message = parseBlock(json, normalizeA2UIMessage, 'a2ui block parse failed');
      if (message) a2uiMessages.push(message);
    } catch (error: unknown) {
      surfaceParseErrors.push(error instanceof Error ? error.message : String(error));
    }
    return '';
  });

  text = text.replace(/```\s*a2ui\s*\n([\s\S]*?)```/g, (_match, json) => {
    try {
      const message = parseBlock(json, normalizeA2UIMessage, 'a2ui block parse failed');
      if (message) a2uiMessages.push(message);
    } catch (error: unknown) {
      surfaceParseErrors.push(error instanceof Error ? error.message : String(error));
    }
    return '';
  });

  text = text.replace(/```a2a\s*\n([\s\S]*?)```/g, (_match, json) => {
    try {
      const message = parseBlock(json, normalizeA2AMessage, 'a2a block parse failed');
      if (message) a2aMessages.push(message);
    } catch (error: unknown) {
      surfaceParseErrors.push(error instanceof Error ? error.message : String(error));
    }
    return '';
  });

  text = text.replace(/```approval\s*\n([\s\S]*?)```/g, (_match, json) => {
    try {
      const request = parseBlock(json, normalizeApprovalRequest, 'approval block parse failed');
      if (request) approvalRequests.push(request);
    } catch (error: unknown) {
      surfaceParseErrors.push(error instanceof Error ? error.message : String(error));
    }
    return '';
  });

  text = text.replace(/```(?:nerve_route|route)\s*\n([\s\S]*?)```/g, (_match, json) => {
    try {
      const proposal = parseBlock(json, normalizeRoutingProposal, 'routing proposal parse failed');
      if (proposal) routingProposals.push(proposal);
    } catch (error: unknown) {
      surfaceParseErrors.push(error instanceof Error ? error.message : String(error));
    }
    return '';
  });

  text = text.replace(/```mission_proposal\s*\n([\s\S]*?)```/g, (_match, json) => {
    try {
      const proposal = parseBlock(json, normalizeMissionProposal, 'mission proposal parse failed');
      if (proposal) missionProposals.push(proposal);
    } catch (error: unknown) {
      surfaceParseErrors.push(error instanceof Error ? error.message : String(error));
    }
    return '';
  });

  text = text.replace(/>>A2A(\{[\s\S]*?\})<</g, (_match, json) => {
    try {
      const message = parseBlock(json, normalizeA2AMessage, 'a2a legacy block parse failed');
      if (message) a2aMessages.push(message);
    } catch (error: unknown) {
      surfaceParseErrors.push(error instanceof Error ? error.message : String(error));
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
    taskResultRepairs: taskResultBlocks.taskResultRepairs,
    taskResultRepairRequiresReview: taskResultBlocks.taskResultRepairRequiresReview,
    surfaceParseErrors,
  };
}

export { sanitizeSurfaceReplyText };
