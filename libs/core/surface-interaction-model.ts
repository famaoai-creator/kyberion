import { randomUUID } from 'node:crypto';

import {
  buildChronosSurfaceIngressEnvelope,
  buildPresenceSurfaceIngressEnvelope,
  buildSlackSurfaceIngressEnvelope,
} from './surface-ingress-contract.js';
import { getSurfaceProviderManifest } from './surface-provider-manifest.js';
import {
  createSurfaceAsyncRequest,
  enqueueChronosOutboxMessage,
  enqueueSlackOutboxMessage,
  enqueueSurfaceNotification,
} from './surface-coordination-store.js';

import type {
  ChronosSurfaceMetadata,
  PresenceSurfaceMetadata,
  SlackSurfaceMetadata,
  IMessageSurfaceMetadata,
  SlackSurfaceInput,
  SurfaceAsyncChannel,
  SurfaceAsyncRequestRecord,
  SurfaceConversationInput,
  SurfaceConversationMessageInput,
  SurfaceNotificationRecord,
} from './channel-surface-types.js';

export type SurfaceProviderId = SurfaceAsyncChannel;
export type SurfaceReplyMode = 'outbox' | 'notification';

export interface SurfaceCapabilityContract {
  reply: boolean;
  edit: boolean;
  react: boolean;
  notify: boolean;
  asyncRequest: boolean;
  responding: boolean;
}

export interface SurfaceSpaceReplyInput {
  text: string;
  source?: 'surface' | 'nerve' | 'system';
}

export interface SurfaceSpaceNotificationInput {
  title: string;
  text: string;
  status?: 'info' | 'success' | 'error';
  requestId?: string;
  sourceAgentId?: string;
}

export interface SurfaceAsyncRequestInput {
  senderAgentId: string;
  surfaceAgentId: string;
  receiverAgentId: string;
  query: string;
  acceptedText: string;
  requestId?: string;
}

export interface SurfaceReplyReceipt {
  surface: SurfaceProviderId;
  mode: SurfaceReplyMode;
  channel: string;
  threadTs: string;
  text: string;
  path?: string;
  notification?: SurfaceNotificationRecord;
}

export interface SurfaceSpaceContext {
  surface: SurfaceProviderId;
  channel: string;
  threadTs: string;
  correlationId: string;
  capabilities: SurfaceCapabilityContract;
  actorId?: string;
}

export interface SurfaceMessageContext {
  messageId: string;
  surface: SurfaceProviderId;
  channel: string;
  threadTs: string;
  correlationId: string;
  text: string;
  receivedAt: string;
  actorId?: string;
  capabilities: SurfaceCapabilityContract;
}

export interface SurfaceSpace extends SurfaceSpaceContext {
  reply: (input: SurfaceSpaceReplyInput) => SurfaceReplyReceipt;
  notify: (input: SurfaceSpaceNotificationInput) => SurfaceNotificationRecord;
  createAsyncRequest: (input: SurfaceAsyncRequestInput) => SurfaceAsyncRequestRecord;
  responding: <T>(
    operation: () => Promise<T> | T,
    options?: {
      title?: string;
      startedText?: string;
      completedText?: string;
      failedText?: string;
      sourceAgentId?: string;
      requestId?: string;
    },
  ) => Promise<T>;
}

export interface SurfaceMessage extends SurfaceMessageContext {
  space: SurfaceSpace;
  reply: (input: SurfaceSpaceReplyInput) => SurfaceReplyReceipt;
}

export interface BuildSurfaceConversationInputOptions {
  agentId: string;
  senderAgentId: string;
  cwd?: string;
  forcedReceiver?: string;
  missionId?: string;
  teamRole?: string;
  delegationSummaryInstruction?: string;
  slack?: {
    user?: string;
    team?: string;
    channelType?: string;
  };
}

export interface SurfaceProviderDefinition {
  id: SurfaceProviderId;
  capabilities: SurfaceCapabilityContract;
  createSpace: (context: Omit<SurfaceSpaceContext, 'capabilities'>) => SurfaceSpace;
  createMessage: (context: Omit<SurfaceMessageContext, 'capabilities'>) => SurfaceMessage;
}

export class SurfaceUnsupportedActionError extends Error {
  constructor(surface: SurfaceProviderId, action: keyof SurfaceCapabilityContract) {
    super(`Surface ${surface} does not support action ${action}`);
    this.name = 'SurfaceUnsupportedActionError';
  }
}

const SURFACE_PROVIDER_CAPABILITIES: Record<SurfaceProviderId, SurfaceCapabilityContract> = {
  slack: {
    reply: true,
    edit: false,
    react: false,
    notify: true,
    asyncRequest: true,
    responding: true,
  },
  chronos: {
    reply: true,
    edit: false,
    react: false,
    notify: true,
    asyncRequest: true,
    responding: true,
  },
  imessage: {
    reply: true,
    edit: false,
    react: false,
    notify: true,
    asyncRequest: true,
    responding: true,
  },
  presence: {
    reply: false,
    edit: false,
    react: false,
    notify: true,
    asyncRequest: true,
    responding: true,
  },
};

function getSurfaceCapabilities(surface: SurfaceProviderId): SurfaceCapabilityContract {
  return { ...SURFACE_PROVIDER_CAPABILITIES[surface] };
}

function ensureCapability(surface: SurfaceProviderId, capabilities: SurfaceCapabilityContract, action: keyof SurfaceCapabilityContract): void {
  if (!capabilities[action]) {
    throw new SurfaceUnsupportedActionError(surface, action);
  }
}

function createReplyHandler(space: SurfaceSpaceContext): (input: SurfaceSpaceReplyInput) => SurfaceReplyReceipt {
  return (input) => {
    ensureCapability(space.surface, space.capabilities, 'reply');
    if (space.surface === 'slack') {
      const path = enqueueSlackOutboxMessage({
        correlationId: space.correlationId,
        channel: space.channel,
        threadTs: space.threadTs,
        text: input.text,
        source: input.source,
      });
      return {
        surface: space.surface,
        mode: 'outbox',
        channel: space.channel,
        threadTs: space.threadTs,
        text: input.text,
        path,
      };
    }
    if (space.surface === 'chronos') {
      const path = enqueueChronosOutboxMessage({
        correlationId: space.correlationId,
        channel: space.channel,
        threadTs: space.threadTs,
        text: input.text,
        source: input.source,
      });
      return {
        surface: space.surface,
        mode: 'outbox',
        channel: space.channel,
        threadTs: space.threadTs,
        text: input.text,
        path,
      };
    }
    throw new SurfaceUnsupportedActionError(space.surface, 'reply');
  };
}

function defaultNotificationSourceAgentId(space: SurfaceSpaceContext): string {
  if (space.actorId) return space.actorId;
  if (space.surface === 'chronos') return 'chronos-surface-agent';
  if (space.surface === 'presence') return 'presence-surface-agent';
  return 'slack-surface-agent';
}

function createNotifyHandler(space: SurfaceSpaceContext): (input: SurfaceSpaceNotificationInput) => SurfaceNotificationRecord {
  return (input) => {
    ensureCapability(space.surface, space.capabilities, 'notify');
    return enqueueSurfaceNotification({
      surface: space.surface,
      channel: space.channel,
      threadTs: space.threadTs,
      sourceAgentId: input.sourceAgentId || defaultNotificationSourceAgentId(space),
      title: input.title,
      text: input.text,
      status: input.status,
      requestId: input.requestId,
    });
  };
}

function createAsyncRequestHandler(space: SurfaceSpaceContext): (input: SurfaceAsyncRequestInput) => SurfaceAsyncRequestRecord {
  return (input) => {
    ensureCapability(space.surface, space.capabilities, 'asyncRequest');
    return createSurfaceAsyncRequest({
      surface: space.surface,
      channel: space.channel,
      threadTs: space.threadTs,
      senderAgentId: input.senderAgentId,
      surfaceAgentId: input.surfaceAgentId,
      receiverAgentId: input.receiverAgentId,
      query: input.query,
      acceptedText: input.acceptedText,
      requestId: input.requestId,
    });
  };
}

function createRespondingHandler(space: SurfaceSpace): SurfaceSpace['responding'] {
  return async (operation, options) => {
    ensureCapability(space.surface, space.capabilities, 'responding');
    if (options?.startedText) {
      space.notify({
        title: options.title || 'Working',
        text: options.startedText,
        status: 'info',
        requestId: options.requestId,
        sourceAgentId: options.sourceAgentId,
      });
    }
    try {
      const result = await operation();
      if (options?.completedText) {
        space.notify({
          title: options.title || 'Completed',
          text: options.completedText,
          status: 'success',
          requestId: options.requestId,
          sourceAgentId: options.sourceAgentId,
        });
      }
      return result;
    } catch (error: any) {
      if (options?.failedText) {
        space.notify({
          title: options.title || 'Failed',
          text: options.failedText,
          status: 'error',
          requestId: options.requestId,
          sourceAgentId: options.sourceAgentId,
        });
      }
      throw error;
    }
  };
}

export function createSurfaceSpace(context: Omit<SurfaceSpaceContext, 'capabilities'>): SurfaceSpace {
  const capabilities = getSurfaceCapabilities(context.surface);
  const base: SurfaceSpaceContext = {
    ...context,
    capabilities,
  };
  const space: SurfaceSpace = {
    ...base,
    reply: createReplyHandler(base),
    notify: createNotifyHandler(base),
    createAsyncRequest: createAsyncRequestHandler(base),
    responding: async () => {
      throw new Error('unreachable');
    },
  };
  space.responding = createRespondingHandler(space);
  return space;
}

export function createSurfaceMessage(context: Omit<SurfaceMessageContext, 'capabilities'>): SurfaceMessage {
  const space = createSurfaceSpace({
    surface: context.surface,
    channel: context.channel,
    threadTs: context.threadTs,
    correlationId: context.correlationId,
    actorId: context.actorId,
  });
  return {
    ...context,
    capabilities: getSurfaceCapabilities(context.surface),
    space,
    reply: (input) => space.reply(input),
  };
}

export const slackSurfaceProviderDefinition: SurfaceProviderDefinition = {
  id: 'slack',
  capabilities: getSurfaceCapabilities('slack'),
  createSpace: createSurfaceSpace,
  createMessage: createSurfaceMessage,
};

export const chronosSurfaceProviderDefinition: SurfaceProviderDefinition = {
  id: 'chronos',
  capabilities: getSurfaceCapabilities('chronos'),
  createSpace: createSurfaceSpace,
  createMessage: createSurfaceMessage,
};

export const presenceSurfaceProviderDefinition: SurfaceProviderDefinition = {
  id: 'presence',
  capabilities: getSurfaceCapabilities('presence'),
  createSpace: createSurfaceSpace,
  createMessage: createSurfaceMessage,
};

export function getSurfaceProviderDefinition(surface: SurfaceProviderId): SurfaceProviderDefinition {
  if (surface === 'slack') return slackSurfaceProviderDefinition;
  if (surface === 'chronos') return chronosSurfaceProviderDefinition;
  return presenceSurfaceProviderDefinition;
}

export function createSlackSurfaceSpace(input: SlackSurfaceInput & { correlationId?: string }): SurfaceSpace {
  return createSurfaceSpace({
    surface: 'slack',
    channel: input.channel,
    threadTs: input.threadTs || input.ts || 'unknown',
    correlationId: input.correlationId || randomUUID(),
    actorId: 'slack-surface-agent',
  });
}

export function createSlackSurfaceMessage(input: SlackSurfaceInput & { correlationId?: string; messageId?: string }): SurfaceMessage {
  return createSurfaceMessage(buildSlackSurfaceIngressEnvelope(input));
}

export function createChronosSurfaceMessage(input: {
  text: string;
  sessionId?: string;
  requesterId?: string;
  correlationId?: string;
  messageId?: string;
  receivedAt?: string;
}): SurfaceMessage {
  return createSurfaceMessage(buildChronosSurfaceIngressEnvelope(input));
}

export function createPresenceSurfaceMessage(input: {
  text: string;
  channel?: string;
  threadTs?: string;
  speakerId?: string;
  correlationId?: string;
  messageId?: string;
  receivedAt?: string;
}): SurfaceMessage {
  return createSurfaceMessage(buildPresenceSurfaceIngressEnvelope(input));
}

function buildSlackSurfaceConversationQuery(message: SurfaceMessage, options: BuildSurfaceConversationInputOptions): string {
  const metadataLines = [
    'Surface: slack',
    `Channel: ${message.channel}`,
    `Thread: ${message.threadTs}`,
    `User: ${options.slack?.user || 'unknown'}`,
    `Channel type: ${options.slack?.channelType || 'unknown'}`,
  ];
  return [
    ...metadataLines,
    '',
    'User message:',
    message.text,
  ].join('\n');
}

export function buildSurfaceConversationInputFromMessage(
  message: SurfaceMessage,
  options: BuildSurfaceConversationInputOptions,
): SurfaceConversationInput {
  const query = message.surface === 'slack'
    ? buildSlackSurfaceConversationQuery(message, options)
    : message.text;
  return {
    agentId: options.agentId,
    query,
    senderAgentId: options.senderAgentId,
    surface: message.surface,
    surfaceText: message.text,
    surfaceMetadata: message.surface === 'slack'
      ? {
        surface: 'slack',
        user: options.slack?.user,
        team: options.slack?.team,
        channelType: options.slack?.channelType,
        threadTs: message.threadTs,
        channel: message.channel,
      } satisfies SlackSurfaceMetadata
      : {
        surface: message.surface as 'chronos' | 'presence' | 'imessage',
        actorId: message.actorId,
        threadTs: message.threadTs,
        channel: message.channel,
      } satisfies ChronosSurfaceMetadata | PresenceSurfaceMetadata | IMessageSurfaceMetadata,
    cwd: options.cwd,
    forcedReceiver: options.forcedReceiver,
    missionId: options.missionId,
    teamRole: options.teamRole,
    delegationSummaryInstruction: options.delegationSummaryInstruction,
  };
}

export function createSurfaceMessageFromConversationInput(input: SurfaceConversationMessageInput): SurfaceMessage {
  if (input.surface === 'slack') {
    return createSlackSurfaceMessage({
      user: input.metadata?.user || input.actorId,
      text: input.text,
      channel: input.channel,
      ts: input.receivedAt,
      threadTs: input.threadTs,
      team: input.metadata?.team,
      channelType: input.metadata?.channelType,
      correlationId: input.correlationId,
      messageId: input.messageId,
    });
  }
  if (input.surface === 'chronos') {
    return createChronosSurfaceMessage({
      text: input.text,
      sessionId: input.threadTs,
      requesterId: input.actorId,
      correlationId: input.correlationId,
      messageId: input.messageId,
      receivedAt: input.receivedAt,
    });
  }
  return createPresenceSurfaceMessage({
    text: input.text,
    channel: input.channel,
    threadTs: input.threadTs,
    speakerId: input.actorId,
    correlationId: input.correlationId,
    messageId: input.messageId,
    receivedAt: input.receivedAt,
  });
}

export function buildSurfaceConversationInput(input: SurfaceConversationMessageInput): SurfaceConversationInput {
  const message = createSurfaceMessageFromConversationInput(input);
  const manifest = getSurfaceProviderManifest(input.surface);
  return buildSurfaceConversationInputFromMessage(message, {
    agentId: input.agentId || manifest.agentId,
    senderAgentId: input.senderAgentId,
    cwd: input.cwd,
    forcedReceiver: input.forcedReceiver,
    missionId: input.missionId,
    teamRole: input.teamRole,
    delegationSummaryInstruction: input.delegationSummaryInstruction,
    slack: input.surface === 'slack'
      ? {
        user: input.metadata?.user || input.actorId,
        team: input.metadata?.team,
        channelType: input.metadata?.channelType,
      }
      : undefined,
  });
}
