export declare const logger: {
  info: (msg: string) => void;
  success: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

export declare const ui: {
  summarize: (data: any) => any;
  formatDuration: (ms: number) => string;
  confirm: (question: string) => Promise<boolean>;
  ask: (question: string) => Promise<string>;
  spinner: (msg: string) => { stop: (success?: boolean) => void };
  progressBar: (current: number, total: number, width?: number) => string;
};

export declare const sre: {
  analyzeRootCause: (msg: string) => { cause: string; impact: string; recommendation: string } | null;
};

export declare const fileUtils: {
  getCurrentRole: () => string;
  getFullRoleConfig: () => any;
  ensureDir: (dirPath: string) => void;
  readJson: (filePath: string) => any;
  writeJson: (filePath: string, data: any) => void;
};

export declare const errorHandler: (err: Error | string, context?: string) => void;
