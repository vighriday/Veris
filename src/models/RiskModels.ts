import { GraphNode, GraphEdge } from './GraphModels';

export interface DiffReport {
    addedNodes: GraphNode[];
    removedNodes: GraphNode[];
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
