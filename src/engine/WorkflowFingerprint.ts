import * as crypto from 'crypto';
import { WorkflowDomain } from '../models/WorkflowModels';
import { BehavioralGraph } from '../models/GraphModels';

/**
 * Produces a deterministic fingerprint per workflow.
 *
 * The fingerprint is the SHA-256 of:
 *  - sorted member node ids
 *  - sorted internal edge signatures (source -> target : type)
 *
 * A change in the fingerprint between runs means the workflow's structural
 * shape changed: members joined/left, or internal call topology shifted.
 * This is how Veris detects silent rewrites that pass other checks.
 */
export interface WorkflowFingerprint {
    workflowId: string;
    workflowName: string;
    fingerprint: string;
    memberCount: number;
}

export class WorkflowFingerprintEngine {
    public fingerprint(domain: WorkflowDomain, graph: BehavioralGraph): WorkflowFingerprint {
        const memberSet = new Set(domain.memberNodeIds);
        const members = [...domain.memberNodeIds].sort();
        const internalEdges = graph.getEdges()
            .filter(e => memberSet.has(e.sourceId) && memberSet.has(e.targetId))
            .map(e => `${e.sourceId}>${e.targetId}:${e.type}`)
            .sort();

        const h = crypto.createHash('sha256');
        h.update(domain.kind);
        for (const id of members) h.update('\n' + id);
        h.update('\n---\n');
        for (const sig of internalEdges) h.update('\n' + sig);

        return {
            workflowId: domain.id,
            workflowName: domain.name,
            fingerprint: h.digest('hex'),
            memberCount: members.length
        };
    }

    public fingerprintAll(domains: WorkflowDomain[], graph: BehavioralGraph): WorkflowFingerprint[] {
        return domains.map(d => this.fingerprint(d, graph));
    }
}
