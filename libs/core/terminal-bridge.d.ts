export declare const terminalBridge: {
    findIdleSession: () => any;
    injectAndExecute: (winId: string, sessionId: string, text: string, terminalType?: string) => Promise<any>;
    readLatestOutput: (winId: string, sessionId: string, terminalType?: string) => string;
};
//# sourceMappingURL=terminal-bridge.d.ts.map