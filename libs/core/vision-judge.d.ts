/**
 * Vision Judge Utility
 * Helps AI break logical deadlocks by consulting the Sovereign (Vision).
 */
export interface TieBreakOption {
    id: string;
    description: string;
    logic_score: number;
    vision_alignment_hint?: string;
}
export declare function consultVision(context: string, options: TieBreakOption[]): Promise<TieBreakOption>;
//# sourceMappingURL=vision-judge.d.ts.map