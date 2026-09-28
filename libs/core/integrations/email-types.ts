export interface EmailParams {
  /** Optional governed backend selection. Omit to use the configured default or auto policy. */
  backend?: string;
  to?: string;
  cc?: string;
  subject?: string;
  body?: string;
  body_file?: string;
  from?: string;
  export_as?: string;
}

export interface EmailResult {
  status: 'succeeded' | 'failed';
  provider: string;
  message?: string;
  error?: string;
}

export interface EmailProvider {
  readonly id: string;
  isAvailable(): boolean | Promise<boolean>;
  send(params: EmailParams): Promise<EmailResult>;
  createDraft(params: EmailParams): Promise<EmailResult>;
}
