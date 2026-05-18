import { BehavioralGraph, GraphNode } from '../models/GraphModels';
import { WorkflowDomain, WorkflowKind } from '../models/WorkflowModels';
import { RiskReport } from '../models/RiskModels';

/**
 * Generates concrete adversarial probes for Tier 3 verification targets.
 *
 * This is the "what would actually break this?" layer. Each probe is a structured
 * hypothesis: a workflow-aware concrete stressor (e.g. "fire two concurrent checkout
 * requests with identical idempotency keys") that an autonomous agent can execute.
 *
 * The generator never executes — it only produces directives. External agents
 * (Claude Code, Cursor, CI) handle execution.
 */
export interface AdversarialProbe {
    nodeId: string;
    workflowId?: string;
    workflowKind?: string;
    category: 'concurrency' | 'idempotency' | 'malformed-state' | 'retry-storm' | 'partial-failure' | 'ordering' | 'auth-edge' | 'expiry' | 'cache-stampede' | 'replay';
    scenario: string;
    expectedInvariant: string;
    severity: 'low' | 'medium' | 'high';
}

const PROBES_BY_KIND: Partial<Record<WorkflowKind, AdversarialProbe[]>> = {
    [WorkflowKind.Authentication]: [
        { nodeId: '', category: 'expiry', scenario: 'Refresh token at the exact expiry boundary while two requests are in flight.', expectedInvariant: 'No request observes a half-rotated session.', severity: 'high' },
        { nodeId: '', category: 'replay', scenario: 'Replay a captured login response after logout.', expectedInvariant: 'Replay must be rejected; session must not resurrect.', severity: 'high' },
        { nodeId: '', category: 'auth-edge', scenario: 'OAuth callback arrives twice for the same code parameter.', expectedInvariant: 'Second callback is a no-op or explicit error; no duplicate account linkage.', severity: 'high' }
    ],
    [WorkflowKind.Session]: [
        { nodeId: '', category: 'concurrency', scenario: 'Two parallel requests refresh the session cookie simultaneously.', expectedInvariant: 'Cookie value converges; neither request 401s mid-flight.', severity: 'high' }
    ],
    [WorkflowKind.Payments]: [
        { nodeId: '', category: 'idempotency', scenario: 'Submit charge twice with the same idempotency key inside a 500ms window.', expectedInvariant: 'Exactly one ledger entry; second call returns the first result.', severity: 'high' },
        { nodeId: '', category: 'retry-storm', scenario: 'Webhook delivery retries 5x within 10 seconds.', expectedInvariant: 'No duplicate fulfillment; downstream events deduped.', severity: 'high' },
        { nodeId: '', category: 'partial-failure', scenario: 'Capture succeeds at gateway, response times out before reaching us.', expectedInvariant: 'Reconciliation eventually marks order paid; no orphan charge.', severity: 'high' }
    ],
    [WorkflowKind.Billing]: [
        { nodeId: '', category: 'ordering', scenario: 'Subscription downgrade event arrives before its upgrade event due to reorder.', expectedInvariant: 'Plan state converges to the latest by event_ts, not arrival order.', severity: 'medium' }
    ],
    [WorkflowKind.Checkout]: [
        { nodeId: '', category: 'concurrency', scenario: 'Two clients submit the same cart concurrently after inventory dropped to 1.', expectedInvariant: 'Exactly one order created; the other client sees out-of-stock.', severity: 'high' }
    ],
    [WorkflowKind.Webhooks]: [
        { nodeId: '', category: 'replay', scenario: 'Replay a 24-hour-old signed payload with the original signature.', expectedInvariant: 'Replay rejected by timestamp window even though signature is valid.', severity: 'high' },
        { nodeId: '', category: 'retry-storm', scenario: 'Sender delivers 50 retries of the same event id within 1 minute.', expectedInvariant: 'Handler is idempotent; no duplicate side effects; backpressure honored.', severity: 'high' }
    ],
    [WorkflowKind.Notifications]: [
        { nodeId: '', category: 'idempotency', scenario: 'Duplicate enqueue of the same notification id.', expectedInvariant: 'User receives one message, not two.', severity: 'medium' }
    ],
    [WorkflowKind.Queue]: [
        { nodeId: '', category: 'partial-failure', scenario: 'Worker crashes after side effect but before ack.', expectedInvariant: 'Re-delivery is safe (idempotent handler) or quarantined as poison.', severity: 'high' },
        { nodeId: '', category: 'concurrency', scenario: 'Two consumers visibility-timeout race on the same job.', expectedInvariant: 'At-most-once side effect; no double processing.', severity: 'high' }
    ],
    [WorkflowKind.Caching]: [
        { nodeId: '', category: 'cache-stampede', scenario: 'Mass cache expiry triggers thundering herd on origin.', expectedInvariant: 'Single-flight or jittered refresh; origin not overwhelmed.', severity: 'high' },
        { nodeId: '', category: 'malformed-state', scenario: 'Invalidation event arrives out of order with the write.', expectedInvariant: 'No permanent stale-after-write; staleness bounded by TTL.', severity: 'medium' }
    ],
    [WorkflowKind.Persistence]: [
        { nodeId: '', category: 'concurrency', scenario: 'Two transactions update the same row; commit order non-deterministic.', expectedInvariant: 'Either explicit lock, optimistic concurrency, or last-writer-wins is documented and tested.', severity: 'medium' }
    ],
    [WorkflowKind.Sync]: [
        { nodeId: '', category: 'partial-failure', scenario: 'Network partition mid-sync; both sides accept writes.', expectedInvariant: 'Conflict resolution converges deterministically on reconnect.', severity: 'high' }
    ],
    [WorkflowKind.Realtime]: [
        { nodeId: '', category: 'replay', scenario: 'Client reconnects and replays buffered messages out of order.', expectedInvariant: 'Server reorders by sequence id; no duplicate UI state.', severity: 'medium' }
    ],
    [WorkflowKind.Routing]: [
        { nodeId: '', category: 'auth-edge', scenario: 'Middleware order changes — unauthenticated request reaches handler.', expectedInvariant: 'Auth runs before any handler with @authenticated semantics.', severity: 'high' }
    ],
    [WorkflowKind.Orchestration]: [
        { nodeId: '', category: 'partial-failure', scenario: 'Step 3 of 5 succeeds, step 4 fails permanently.', expectedInvariant: 'Compensating actions run; system reaches a documented terminal state.', severity: 'high' }
    ],
    [WorkflowKind.AI]: [
        { nodeId: '', category: 'malformed-state', scenario: 'Tool returns schema-violating JSON to the model.', expectedInvariant: 'Caller validates and either repairs or fails closed; no silent execution of broken payload.', severity: 'high' }
    ]
};

const GENERIC_PROBES: AdversarialProbe[] = [
    { nodeId: '', category: 'malformed-state', scenario: 'Pass null where the type system says non-null is enforced at boundary.', expectedInvariant: 'Boundary validation rejects; never trusts caller.', severity: 'low' },
    { nodeId: '', category: 'concurrency', scenario: 'Two concurrent invocations interleave at any await boundary.', expectedInvariant: 'No shared mutable state without lock or atomic.', severity: 'medium' }
];

export class AdversarialProbeGenerator {

    public generate(
        risks: RiskReport[],
        workflows: WorkflowDomain[],
        graphNodes: GraphNode[],
        opts: { maxPerNode?: number } = {}
    ): AdversarialProbe[] {
        const max = opts.maxPerNode ?? 3;
        const nodeToWorkflow = new Map<string, WorkflowDomain>();
        for (const d of workflows) for (const id of d.memberNodeIds) nodeToWorkflow.set(id, d);

        const nodesById = new Map(graphNodes.map(n => [n.id, n]));
        const high = risks.filter(r => r.score.overallRisk >= 40)
            .sort((a, b) => b.score.overallRisk - a.score.overallRisk);

        const probes: AdversarialProbe[] = [];
        for (const r of high) {
            const node = nodesById.get(r.nodeId);
            if (!node) continue;
            const wf = nodeToWorkflow.get(r.nodeId);
            const template = (wf && PROBES_BY_KIND[wf.kind]) || GENERIC_PROBES;
            for (const p of template.slice(0, max)) {
                probes.push({
                    ...p,
                    nodeId: r.nodeId,
                    workflowId: wf?.id,
                    workflowKind: wf?.kind
                });
            }
        }
        return probes;
    }
}
