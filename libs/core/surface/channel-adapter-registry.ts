/**
 * Channel adapter registry (RS-06).
 *
 * The `channel_adapters` section of
 * `knowledge/product/governance/surface-provider-manifests.json` is the single
 * source for which delivery channels exist and how each one behaves: its
 * markup dialect and escaping rules, how operator notifications are delivered,
 * how presence dispatch reaches it, which message shape its ingress uses and
 * which mission-event stream it records into. Callers derive channel lists and
 * per-channel decisions from here instead of keeping their own literal lists.
 *
 * Unknown channel ids fail closed with an operator-visible reason.
 */
import { loadSurfaceProviderManifestFile } from './surface-provider-policy.js';

export type ChannelMarkupDialect =
  'plain' | 'slack-mrkdwn' | 'telegram-markdown-legacy' | 'discord-markdown';

export type ChannelNotificationDelivery = 'surface-outbox' | 'imessage-direct' | 'local-inbox';
export type ChannelPresenceDispatch = 'slack-webclient' | 'satellite-outbox';
export type ChannelMessageShape = 'generic' | 'slack-thread' | 'chronos-session';
export type ChannelMissionEventStream = 'shared' | 'slack' | 'chronos';

export interface ChannelMarkupRules {
  dialect: ChannelMarkupDialect;
  /** Literal character → entity replacements (applied first, in declaration order). */
  entity_escapes?: Record<string, string>;
  /** Characters that are escaped by prefixing a backslash. */
  backslash_escape_chars?: string;
  /** Mass-mention keywords (`@everyone`) neutralized with a zero-width space. */
  mention_guards?: string[];
}

export interface ChannelAdapterDescriptor {
  surface_provider?: string;
  local?: boolean;
  markup: ChannelMarkupRules;
  operator_notification?: {
    delivery: ChannelNotificationDelivery;
    default_target?: string;
  };
  presence_dispatch?: ChannelPresenceDispatch;
  human_chat: boolean;
  message_shape?: ChannelMessageShape;
  mission_event_stream?: ChannelMissionEventStream;
}

export interface ChannelAdapterRecord extends ChannelAdapterDescriptor {
  id: string;
}

interface ManifestFileWithChannelAdapters {
  providers: Record<string, unknown>;
  channel_adapters?: Record<string, ChannelAdapterDescriptor>;
}

function loadChannelAdapterMap(): Record<string, ChannelAdapterDescriptor> {
  const file = loadSurfaceProviderManifestFile() as unknown as ManifestFileWithChannelAdapters;
  const adapters = file.channel_adapters ?? {};
  for (const [id, adapter] of Object.entries(adapters)) {
    if (adapter.local) continue;
    const provider = adapter.surface_provider ?? id;
    if (!(provider in file.providers)) {
      throw new Error(
        `[channel-adapter-registry] channel "${id}" names surface provider "${provider}" which is not registered — add it to surface-provider-manifests.json providers or mark the channel local`
      );
    }
  }
  return adapters;
}

export function listChannelAdapters(): ChannelAdapterRecord[] {
  return Object.entries(loadChannelAdapterMap()).map(([id, adapter]) => ({ id, ...adapter }));
}

export function findChannelAdapter(id: string): ChannelAdapterRecord | undefined {
  const adapter = loadChannelAdapterMap()[id];
  return adapter ? { id, ...adapter } : undefined;
}

/** Resolve a channel adapter; unknown channels fail closed. */
export function getChannelAdapter(id: string): ChannelAdapterRecord {
  const adapter = findChannelAdapter(id);
  if (!adapter) {
    throw new Error(
      `[channel-adapter-registry] unknown channel "${id}" — register it under channel_adapters in knowledge/product/governance/surface-provider-manifests.json`
    );
  }
  return adapter;
}

/** Channels that can be an operator-notification destination. */
export function listOperatorNotificationChannels(): string[] {
  return listChannelAdapters()
    .filter((adapter) => adapter.operator_notification)
    .map((adapter) => adapter.id);
}

/** Channels on which a human operator converses (chat surfaces). */
export function listHumanChatChannels(): string[] {
  return listChannelAdapters()
    .filter((adapter) => adapter.human_chat)
    .map((adapter) => adapter.id);
}

/** Channels presence dispatch can address with a `<channel>:<id>` prefix. */
export function listPresenceDispatchChannels(): Array<{
  id: string;
  via: ChannelPresenceDispatch;
}> {
  return listChannelAdapters().flatMap((adapter) =>
    adapter.presence_dispatch ? [{ id: adapter.id, via: adapter.presence_dispatch }] : []
  );
}

/**
 * Message shape for a surface's ingress. Surfaces without a channel adapter
 * entry use the generic shape.
 */
export function resolveChannelMessageShape(surface: string): ChannelMessageShape {
  return findChannelAdapter(surface)?.message_shape ?? 'generic';
}

/**
 * Mission-event stream for a surface. Surfaces without a dedicated stream record
 * into the shared mission-control observability stream.
 */
export function resolveChannelMissionEventStream(surface: string): ChannelMissionEventStream {
  return findChannelAdapter(surface)?.mission_event_stream ?? 'shared';
}

function escapeRegExpLiteral(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|/]/gu, '\\$&');
}

function escapeRegExpClassChar(char: string): string {
  return char === '-' ? '\\-' : escapeRegExpLiteral(char);
}

/** Apply a channel's declared markup escaping rules to untrusted text. */
export function applyChannelMarkupEscapes(text: string, rules: ChannelMarkupRules): string {
  let out = text;
  for (const [literal, entity] of Object.entries(rules.entity_escapes ?? {})) {
    out = out.split(literal).join(entity);
  }
  if (rules.backslash_escape_chars) {
    const chars = Array.from(rules.backslash_escape_chars).map(escapeRegExpClassChar).join('');
    out = out.replace(new RegExp(`[${chars}]`, 'gu'), (char) => `\\${char}`);
  }
  for (const keyword of rules.mention_guards ?? []) {
    out = out.replace(
      new RegExp(`@(${escapeRegExpLiteral(keyword)})`, 'giu'),
      (_match, word: string) => `@\u200b${word}`
    );
  }
  return out;
}

/** Neutralize markup for a registered channel (unknown channels fail closed). */
export function neutralizeChannelMarkup(text: string, channel: string): string {
  return applyChannelMarkupEscapes(text, getChannelAdapter(channel).markup);
}
