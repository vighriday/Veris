import { GraphNode, GraphEdge } from './GraphModels';

export interface DiffReport {
    addedNodes: GraphNode[];
    removedNodes: GraphNode[];
    /**
     * Present in both graphs with a different body hash: the declaration was
     * rewritten while keeping its name and its call targets. This is the "silent
     * rewrite" class — invisible to any comparison that looks only at names and
     * topology, and the case most worth surfacing.
     */
    modifiedNodes: GraphNode[];
    addedEdges: GraphEdge[];
    removedEdges: GraphEdge[];
    impactedNodes: GraphNode[]; // Nodes that depend on changed nodes
}

export interface RiskScore {
    blastRadius: number; // 0 to 100
    runtimeCriticality: number; // 0 to 100
    integrationCount: number;
    dependencyFragility: number; // 0 to 100
    overallRisk: number; // 0 to 100
    explanation: string[]; // Explainability Layer
}

export interface RiskReport {
    nodeId: string;
    score: RiskScore;
}
