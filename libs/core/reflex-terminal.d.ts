/**
 * Reflex Terminal (RT) - Core Logic v2.0 (node-pty Edition)
 * Provides a persistent virtual terminal session using node-pty for true PTY support.
 */
import * as pty from 'node-pty';
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
    private feedbackPath;
    constructor(options?: ReflexTerminalOptions);
    private setupListeners;
    /**
     * Inject a command or raw input into the terminal.
     */
    execute(command: string): void;
    /**
     * Write raw data to the terminal.
     */
    write(data: string): void;
    /**
     * Resize the terminal dimensions.
     */
    resize(cols: number, rows: number): void;
    /**
     * Register an output listener.
     */
    onData(callback: (data: string) => void): pty.IDisposable;
    /**
     * Manually trigger a feedback update to the shared response file.
     */
    persistResponse(text: string, skillName?: string): void;
    kill(): void;
}
//# sourceMappingURL=reflex-terminal.d.ts.map