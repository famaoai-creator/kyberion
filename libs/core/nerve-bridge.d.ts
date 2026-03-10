/**
 * libs/core/nerve-bridge.ts
 * Kyberion Autonomous Nerve System (KANS) - Nerve Bridge v1.2
 * [SECURE-IO COMPLIANT]
 *
 * Provides structured messaging (To/From/Type) over the stimuli bus
 * with Distributed Node Identification (Nerve Cluster Foundation).
 */
export interface NerveMessage {
    id: string;
    ts: string;
    from: string;
    node_id: string;
    to: string | 'broadcast';
    type: 'request' | 'response' | 'event';
    intent: string;
    payload: any;
    metadata?: {
        reply_to?: string;
        mission_id?: string;
        ttl?: number;
    };
}
/**
 * Send a structured message to the nerve bus
 */
export declare function sendNerveMessage(input: {
    to: string | 'broadcast';
    from: string;
    intent: string;
    payload: any;
    type?: NerveMessage['type'];
    replyTo?: string;
}): string;
/**
 * Polling / Listening logic for a specific nerve
 */
export declare function listenToNerve(nerveId: string, onMessage: (msg: NerveMessage) => void): void;
//# sourceMappingURL=nerve-bridge.d.ts.map