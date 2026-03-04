/**
 * Reflex Terminal (RT) - Core Logic v1.1 (Native Bridge Edition)
 * Provides a persistent virtual terminal session using native child_process.
 */
export interface ReflexTerminalOptions {
    shell?: string;
    cwd?: string;
    cols?: number;
    rows?: number;
    feedbackPath?: string;
    onOutput?: (data: string) => void;
}
export declare class ReflexTerminal {
    private proc;
    private feedbackPath;
    constructor(options?: ReflexTerminalOptions);
    private setupListeners;
    /**
     * Inject a command into the terminal.
     */
    execute(command: string): void;
    /**
     * Manually trigger a feedback update to the shared response file.
     */
    persistResponse(text: string, skillName?: string): void;
    kill(): void;
}
//# sourceMappingURL=reflex-terminal.d.ts.map