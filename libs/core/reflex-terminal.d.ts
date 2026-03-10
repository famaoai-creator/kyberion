/**
 * Reflex Terminal (RT) - Self-Healing Edition v3.0
 * Provides terminal session with automatic fallback between node-pty and child_process.
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
    private adapter;
    private feedbackPath;
    constructor(options?: ReflexTerminalOptions);
    private setupListeners;
    execute(command: string): void;
    write(data: string): void;
    resize(cols: number, rows: number, width?: number, height?: number): void;
    getPid(): number | undefined;
    kill(): void;
    persistResponse(text: string, skillName?: string): void;
}
//# sourceMappingURL=reflex-terminal.d.ts.map