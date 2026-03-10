/**
 * Pulse Guard: Ensures Stimuli Integrity via HMAC.
 * [SECRET-GUARD COMPLIANT VERSION]
 */
export declare const pulseGuard: {
    sign: (payload: string) => string;
    verify: (payload: string, signature: string) => boolean;
};
//# sourceMappingURL=pulse-guard.d.ts.map