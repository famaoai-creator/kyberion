export interface SecretRequest {
  action: 'get' | 'set' | 'delete' | 'list';
  service: string;
  account?: string;
  value?: string;
  exportAs?: string;
}

export interface RegistryEntry {
  service: string;
  account: string;
  addedAt: string;
}

export interface SecretResult {
  status: 'success' | 'failed';
  message?: string;
  value?: string;
  entries?: RegistryEntry[];
  error?: string;
  provider: string;
}

export interface SecretProvider {
  readonly id: string;
  isAvailable(): Promise<boolean>;
  get(service: string, account: string): Promise<string | null>;
  set(service: string, account: string, value: string): Promise<void>;
  delete(service: string, account: string): Promise<void>;
}
