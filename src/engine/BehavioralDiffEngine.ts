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

        // Impacted nodes for risk scoring:
        //   1. Every added node — even if it has no edges (isolated new file still
        //      ships behavior that needs verification).
        //   2. Every node touched by an added or removed edge.
        //   3. Only nodes that exist in the *current* head graph qualify — old
        //      tombstones leak risk into output (e.g., when projectRoot is a
        //      subfolder of a larger repo, the parent tree's removed nodes
        //      shouldn't show up).
        const impactedNodesSet: Set<GraphNode> = new Set(addedNodes);

        addedEdges.forEach(e => {
            const target = newNodesMap.get(e.targetId);
            const source = newNodesMap.get(e.sourceId);
            if (target) impactedNodesSet.add(target);
            if (source) impactedNodesSet.add(source);
        });

        removedEdges.forEach(e => {
            const source = newNodesMap.get(e.sourceId);
            if (source) impactedNodesSet.add(source);
            const target = newNodesMap.get(e.targetId);
            if (target) impactedNodesSet.add(target);
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
