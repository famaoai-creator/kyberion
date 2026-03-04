/**
 * Reflex Terminal (RT) - Core Logic v1.0
 * Provides a persistent virtual terminal session with bi-directional neural bridging.
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
    private ptyProcess;
    private outputBuffer;
    private feedbackPath;
    constructor(options?: ReflexTerminalOptions);
    private setupListeners;
    private processOutput;
    /**
     * Inject a command into the terminal.
     */
    execute(command: string): void;
    /**
     * Manually trigger a feedback update to the shared response file.
     * This is what allows the AI to "speak" back to Slack.
     */
    persistResponse(text: string, skillName?: string): void;
    resize(cols: number, rows: number): void;
    kill(): void;
}
//# sourceMappingURL=reflex-terminal.d.ts.map