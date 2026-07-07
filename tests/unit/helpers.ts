import { BehavioralGraph, GraphNode, NodeType, EdgeType } from '../../src/models/GraphModels';
import { RiskReport } from '../../src/models/RiskModels';
import { VerificationPlan, VerificationTarget, VerificationTier } from '../../src/models/VerificationModels';

/** Build a graph node with sensible defaults. */
export function node(id: string, label?: string, type: NodeType = NodeType.Function): GraphNode {
    return { id, label: label ?? id.split('::').pop() ?? id, type };
}

/** Build a graph from node ids and `source->target` edge strings. */
export function graph(nodeIds: string[], edges: string[] = []): BehavioralGraph {
    const g = new BehavioralGraph();
    for (const id of nodeIds) g.addNode(node(id));
    for (const e of edges) {
        const [sourceId, targetId] = e.split('->');
        g.addEdge({ sourceId, targetId, type: EdgeType.DependsOn });
    }
    return g;
}

/** Build a RiskReport with a given overall risk (other fields defaulted). */
export function risk(nodeId: string, overallRisk: number, fragility = 0): RiskReport {
    return {
        nodeId,
        score: {
            blastRadius: 0,
            runtimeCriticality: 0,
            integrationCount: 0,
            dependencyFragility: fragility,
            overallRisk,
            explanation: [],
        },
    };
}

/** Build a single verification target. */
export function target(nodeId: string, tier: VerificationTier): VerificationTarget {
    return { nodeId, tier, directive: `verify ${nodeId}`, priority: 'Medium' };
}

/** Build a verification plan from targets. */
export function plan(targets: VerificationTarget[]): VerificationPlan {
    return { targets, executionRecommendations: [] };
}
