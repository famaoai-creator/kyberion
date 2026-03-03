/**
 * KnowledgeProvider abstracts the access to the `knowledge/` directory.
 * This allows skills to access rules, thresholds, and standards without
 * directly using the `fs` module, making testing significantly easier
 * and reducing environmental dependencies.
 */
export declare class KnowledgeProvider {
    private static mockData;
    private static useMock;
    /**
     * Enable mock mode for testing.
     */
    static enableMockMode(data?: Record<string, any>): void;
    /**
     * Disable mock mode and clear mock data.
     */
    static disableMockMode(): void;
    /**
     * Load and parse a JSON file from the knowledge directory.
     * @param relativePath Path relative to the `knowledge/` root.
     * @param defaultValue Optional default value if the file is not found.
     */
    static getJson<T = any>(relativePath: string, defaultValue?: T): T;
    /**
     * Read raw text content from a knowledge file.
     */
    static getText(relativePath: string, defaultValue?: string): string;
}
//# sourceMappingURL=knowledge-provider.d.ts.map