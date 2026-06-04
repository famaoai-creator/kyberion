export interface EmailParams {
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
  isAvailable(): Promise<boolean>;
  send(params: EmailParams): Promise<EmailResult>;
  createDraft(params: EmailParams): Promise<EmailResult>;
}
