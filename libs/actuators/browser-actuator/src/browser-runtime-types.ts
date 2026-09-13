import type { Browser, BrowserContext, CDPSession, Page } from '@playwright/test';

export interface BrowserRuntime {
  context: BrowserContext;
  tabs: Map<string, Page>;
  pageIds: WeakMap<Page, string>;
  cdpSessions: WeakMap<Page, CDPSession>;
  activeTabId: string;
  consoleEvents: Array<{ tab_id: string; type: string; text: string; ts: string }>;
  networkEvents: Array<{
    tab_id: string;
    method: string;
    url: string;
    resourceType: string;
    ts: string;
  }>;
  navigationPolicy?: {
    allowed_origins?: string[];
    allow_private_network?: boolean;
    allow_data_url?: boolean;
  };
  webAuthn?: {
    authenticatorId?: string;
    enabled: boolean;
    options?: Record<string, any>;
    credentials: Array<Record<string, any>>;
    events: Array<{
      type: string;
      credential?: Record<string, any>;
      credentialId?: string;
      ts: string;
    }>;
  };
}

export interface BrowserRuntimeLease {
  runtime: BrowserRuntime;
  userDataDir: string;
  sessionMetadataPath: string;
  videoDir?: string;
  leaseExpiresAt?: number;
  cdpUrl?: string;
  cdpPort?: number;
  browser?: Browser;
  externalConnection?: boolean;
  scopeFingerprint: string;
}
