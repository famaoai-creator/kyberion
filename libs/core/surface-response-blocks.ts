import type { A2AMessage } from './a2a-bridge.js';
import type { A2UIMessage } from './a2ui.js';
import type {
  MissionProposal,
  NerveRoutingProposal,
  PlanningPacket,
  SlackApprovalRequestDraft,
  SurfaceConversationResult,
} from './channel-surface-types.js';

export function extractSurfaceBlocks(raw: string): SurfaceConversationResult {
  const a2uiMessages: A2UIMessage[] = [];
  const a2aMessages: A2AMessage[] = [];
  const approvalRequests: SlackApprovalRequestDraft[] = [];
  const routingProposals: NerveRoutingProposal[] = [];
  const missionProposals: MissionProposal[] = [];
  const planningPackets: PlanningPacket[] = [];

  let text = raw;

  text = text.replace(/```a2ui\s*\n([\s\S]*?)```/g, (_match, json) => {
    try { a2uiMessages.push(JSON.parse(json.trim()) as A2UIMessage); } catch (_) {}
    return '';
  });

  text = text.replace(/```\s*a2ui\s*\n([\s\S]*?)```/g, (_match, json) => {
    try { a2uiMessages.push(JSON.parse(json.trim()) as A2UIMessage); } catch (_) {}
    return '';
  });

  text = text.replace(/```a2a\s*\n([\s\S]*?)```/g, (_match, json) => {
    try { a2aMessages.push(JSON.parse(json.trim()) as A2AMessage); } catch (_) {}
    return '';
  });

  text = text.replace(/```approval\s*\n([\s\S]*?)```/g, (_match, json) => {
    try { approvalRequests.push(JSON.parse(json.trim())); } catch (_) {}
    return '';
  });

  text = text.replace(/```(?:nerve_route|route)\s*\n([\s\S]*?)```/g, (_match, json) => {
    try { routingProposals.push(JSON.parse(json.trim()) as NerveRoutingProposal); } catch (_) {}
    return '';
  });

  text = text.replace(/```mission_proposal\s*\n([\s\S]*?)```/g, (_match, json) => {
    try { missionProposals.push(JSON.parse(json.trim()) as MissionProposal); } catch (_) {}
    return '';
  });

  text = text.replace(/```planning_packet\s*\n([\s\S]*?)```/g, (_match, json) => {
    try { planningPackets.push(JSON.parse(json.trim()) as PlanningPacket); } catch (_) {}
    return '';
  });

  text = text.replace(/>>A2A(\{[\s\S]*?\})<</g, (_match, json) => {
    try { a2aMessages.push(JSON.parse(json.trim()) as A2AMessage); } catch (_) {}
    return '';
  });

  return {
    text: text.trim(),
    a2uiMessages,
    a2aMessages,
    delegationResults: [],
    approvalRequests,
    routingProposals,
    missionProposals,
    planningPackets,
  };
}
