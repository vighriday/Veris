import { BehavioralGraph, GraphNode } from '../models/GraphModels';
import { DiffReport } from '../models/RiskModels';

export class BehavioralDiffEngine {
    
    public computeDiff(oldGraph: BehavioralGraph, newGraph: BehavioralGraph): DiffReport {
        const oldNodesMap = new Map(oldGraph.getNodes().map(n => [n.id, n]));
        const newNodesMap = new Map(newGraph.getNodes().map(n => [n.id, n]));

        const addedNodes: GraphNode[] = [];
        const removedNodes: GraphNode[] = [];

        newNodesMap.forEach((node, id) => {
            if (!oldNodesMap.has(id)) addedNodes.push(node);
        });

        oldNodesMap.forEach((node, id) => {
            if (!newNodesMap.has(id)) removedNodes.push(node);
        });

        // Simplified edge diffs
        const oldEdges = oldGraph.getEdges().map(e => `${e.sourceId}->${e.targetId}`);
        const newEdges = newGraph.getEdges().map(e => `${e.sourceId}->${e.targetId}`);
        
        const addedEdges = newGraph.getEdges().filter(e => !oldEdges.includes(`${e.sourceId}->${e.targetId}`));
        const removedEdges = oldGraph.getEdges().filter(e => !newEdges.includes(`${e.sourceId}->${e.targetId}`));

        // Impacted workflows/nodes (Blast Radius basis)
        // If a node was removed or added, any node depending on it / interacting with it is impacted.
        // For simplicity, any new node impacts its immediate connections.
        const impactedNodesSet: Set<GraphNode> = new Set();
        addedEdges.forEach(e => {
            const target = newNodesMap.get(e.targetId);
            const source = newNodesMap.get(e.sourceId);
            if (target) impactedNodesSet.add(target);
            if (source) impactedNodesSet.add(source);
        });

        removedEdges.forEach(e => {
            const source = newNodesMap.get(e.sourceId) || oldNodesMap.get(e.sourceId);
            if (source) impactedNodesSet.add(source);
        });

        return {
            addedNodes,
            removedNodes,
            addedEdges,
            removedEdges,
            impactedNodes: Array.from(impactedNodesSet)
        };
    }
}
