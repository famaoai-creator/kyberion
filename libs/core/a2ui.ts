import { logger } from './core.js';
import { getRegisteredEnvText } from './foundation/env.js';
import { redactSensitiveObject } from './network.js';

/**
 * Kyberion A2UI (Agent-to-User Interface) Protocol v0.2.0
 * Inspired by OpenClaw A2UI.
 */

export type A2UIComponentType =
  | 'text'
  | 'button'
  | 'card'
  | 'container'
  // Shared Chronos display catalog used by surface response blocks and
  // headless-to-A2UI adapters. Keeping these in the protocol type prevents
  // the adapter layer from falling back to `any` for standard components.
  | 'display:hero'
  | 'display:badges'
  | 'display:section'
  | 'display:gauge'
  | 'display:log'
  | 'display:table'
  | 'display:status'
  | 'display:kv'
  | 'display:metric'
  | 'display:metrics-row'
  | 'display:timeline'
  | 'display:progress'
  | 'display:alert'
  | 'display:code'
  | 'display:list'
  | 'display:card'
  | 'display:grid'
  | 'display:donut'
  | 'display:bar-chart'
  | 'display:stacked-bar'
  | 'display:sparkline'
  // Chronos Specific Components
  | 'kb-layout-grid'
  | 'kb-status-orbit'
  | 'kb-mission-card'
  | 'kb-artifact-tile'
  | 'kb-intervention-panel'
  // Presence Specific Components
  | 'presence.status'
  | 'presence.subtitle'
  | 'presence.transcript'
  | 'presence.avatar';

export type A2UIDataModel = Record<string, unknown>;

export interface A2UIComponent {
  id: string;
  type: A2UIComponentType;
  props: A2UIDataModel;
  children?: string[];
}

export interface A2UIMessage {
  createSurface?: {
    surfaceId: string;
    catalogId: string;
    title?: string;
    titleKey?: string;
  };
  updateComponents?: {
    surfaceId: string;
    components: A2UIComponent[];
  };
  updateDataModel?: {
    surfaceId: string;
    data: A2UIDataModel;
  };
  deleteSurface?: {
    surfaceId: string;
  };
}

export const A2UI_SURFACE_ID = /^[a-z0-9][a-z0-9:_-]{0,80}$/u;
export const A2UI_COMPONENT_TYPE = /^[a-z0-9][a-z0-9:._-]{0,80}$/u;

function assertKnownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string
): void {
  const allowedKeys = new Set(allowed);
  const unknownKey = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknownKey) throw new Error(`A2UI ${label} contains unknown field: ${unknownKey}.`);
}

/**
 * Validate the structural A2UI wire contract before a surface applies a message.
 * Surface-specific scope and component policy remains outside this protocol parser.
 */
export function validateA2UIMessage(value: unknown): A2UIMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('A2UI message must be an object.');
  }
  const message = value as Record<string, unknown>;
  assertKnownKeys(
    message,
    ['createSurface', 'updateComponents', 'updateDataModel', 'deleteSurface'],
    'message'
  );
  const operations = [
    'createSurface',
    'updateComponents',
    'updateDataModel',
    'deleteSurface',
  ].filter((key) => message[key] !== undefined);
  if (operations.length !== 1) throw new Error('A2UI message must contain exactly one operation.');

  const operation = message[operations[0]];
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
    throw new Error(`A2UI ${operations[0]} payload must be an object.`);
  }
  const payload = operation as Record<string, unknown>;
  const operationName = operations[0];
  const payloadKeys = {
    createSurface: ['surfaceId', 'catalogId', 'title', 'titleKey'],
    updateComponents: ['surfaceId', 'components'],
    updateDataModel: ['surfaceId', 'data'],
    deleteSurface: ['surfaceId'],
  } as const;
  assertKnownKeys(payload, payloadKeys[operationName], `${operationName} payload`);
  const surfaceId = payload.surfaceId;
  if (typeof surfaceId !== 'string' || !A2UI_SURFACE_ID.test(surfaceId)) {
    throw new Error('A2UI surfaceId is invalid.');
  }
  if (operations[0] === 'createSurface') {
    if (typeof payload.catalogId !== 'string' || !A2UI_SURFACE_ID.test(payload.catalogId)) {
      throw new Error('A2UI catalogId is invalid.');
    }
    if (payload.title !== undefined && typeof payload.title !== 'string') {
      throw new Error('A2UI title must be a string.');
    }
    if (payload.titleKey !== undefined && typeof payload.titleKey !== 'string') {
      throw new Error('A2UI titleKey must be a string.');
    }
  }
  if (operations[0] === 'updateComponents') {
    if (!Array.isArray(payload.components)) throw new Error('A2UI components must be an array.');
    for (const component of payload.components) {
      if (!component || typeof component !== 'object' || Array.isArray(component)) {
        throw new Error('A2UI component must be an object.');
      }
      const item = component as Record<string, unknown>;
      assertKnownKeys(item, ['id', 'type', 'props', 'children'], 'component');
      if (typeof item.id !== 'string' || !A2UI_SURFACE_ID.test(item.id)) {
        throw new Error('A2UI component id is invalid.');
      }
      if (typeof item.type !== 'string' || !A2UI_COMPONENT_TYPE.test(item.type)) {
        throw new Error('A2UI component type is invalid.');
      }
      if (!item.props || typeof item.props !== 'object' || Array.isArray(item.props)) {
        throw new Error('A2UI component props must be an object.');
      }
      if (item.children !== undefined) {
        if (
          !Array.isArray(item.children) ||
          item.children.some((child) => typeof child !== 'string')
        ) {
          throw new Error('A2UI component children must be an array of strings.');
        }
      }
    }
  }
  if (operations[0] === 'updateDataModel') {
    if (!payload.data || typeof payload.data !== 'object' || Array.isArray(payload.data)) {
      throw new Error('A2UI data model must be an object.');
    }
  }
  return value as A2UIMessage;
}

export type A2UITransport = (message: A2UIMessage) => void;

export class A2UISurface {
  private components: Map<string, A2UIComponent> = new Map();
  private data: A2UIDataModel = {};

  constructor(
    public readonly surfaceId: string,
    public readonly catalogId: string,
    public title?: string,
    public titleKey?: string
  ) {}

  public setComponent(component: A2UIComponent): this {
    this.components.set(component.id, component);
    return this;
  }

  public removeComponent(id: string): this {
    this.components.delete(id);
    return this;
  }

  public getComponent(id: string): A2UIComponent | undefined {
    return this.components.get(id);
  }

  public setData(key: string, value: unknown): this {
    this.data[key] = value;
    return this;
  }

  public getData(): A2UIDataModel {
    return { ...this.data };
  }

  public buildCreateMessage(): A2UIMessage {
    return {
      createSurface: {
        surfaceId: this.surfaceId,
        catalogId: this.catalogId,
        title: this.title,
        titleKey: this.titleKey,
      },
    };
  }

  public buildUpdateMessage(): A2UIMessage {
    return {
      updateComponents: {
        surfaceId: this.surfaceId,
        components: Array.from(this.components.values()),
      },
    };
  }

  public buildDataMessage(): A2UIMessage {
    return {
      updateDataModel: {
        surfaceId: this.surfaceId,
        data: { ...this.data },
      },
    };
  }

  public buildDeleteMessage(): A2UIMessage {
    return {
      deleteSurface: {
        surfaceId: this.surfaceId,
      },
    };
  }
}

/**
 * A2UI Dispatcher with pluggable transports.
 * Register transports (WebSocket, HTTP, etc.) and broadcast messages to all.
 */
class A2UIDispatcher {
  private transports: A2UITransport[] = [];
  private surfaces: Map<string, A2UISurface> = new Map();

  public registerTransport(transport: A2UITransport): void {
    this.transports.push(transport);
  }

  public removeTransport(transport: A2UITransport): void {
    this.transports = this.transports.filter((t) => t !== transport);
  }

  public trackSurface(surface: A2UISurface): void {
    this.surfaces.set(surface.surfaceId, surface);
  }

  public getSurface(surfaceId: string): A2UISurface | undefined {
    return this.surfaces.get(surfaceId);
  }

  public dispatch(message: A2UIMessage): void {
    const validatedMessage = validateA2UIMessage(message);
    logger.info(`[A2UI_DISPATCH] ${JSON.stringify(validatedMessage)}`);
    for (const transport of this.transports) {
      try {
        transport(validatedMessage);
      } catch (err: unknown) {
        logger.error(`[A2UI_TRANSPORT_ERROR] ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}

export const a2uiDispatcher = new A2UIDispatcher();

/**
 * Bridge HTTP transport: forwards A2UI messages to the Bridge SSE relay.
 */
function createBridgeTransport(
  bridgeUrl = getRegisteredEnvText('KYBERION_A2UI_BRIDGE_URL') ||
    'http://127.0.0.1:3031,http://127.0.0.1:3040'
): A2UITransport {
  const targets = bridgeUrl
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return (message: A2UIMessage) => {
    for (const target of targets) {
      const payload = redactSensitiveObject(message);
      const localadminToken = String(
        getRegisteredEnvText('KYBERION_LOCALADMIN_TOKEN') || ''
      ).trim();
      fetch(`${target}/a2ui/dispatch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(localadminToken ? { Authorization: `Bearer ${localadminToken}` } : {}),
        },
        body: JSON.stringify(payload),
      }).catch((err: unknown) => {
        logger.warn(
          `[A2UI_BRIDGE] Failed to relay to bridge ${target}: ${err instanceof Error ? err.message : String(err)}`
        );
      });
    }
  };
}

// Auto-register bridge transport when running server-side
if (typeof globalThis.fetch === 'function') {
  a2uiDispatcher.registerTransport(createBridgeTransport());
}

/**
 * Dispatch an A2UI message via all registered transports.
 */
export function dispatchA2UI(message: A2UIMessage): void {
  a2uiDispatcher.dispatch(message);
}
