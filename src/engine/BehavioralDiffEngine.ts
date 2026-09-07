import { BehavioralGraph, GraphNode, GraphEdge } from '../models/GraphModels';
import { DiffReport } from '../models/RiskModels';

/**
 * Structural diff between two behavioral graphs.
 *
 * Edge identity includes the edge type, matching `BehavioralGraph.addEdge`, which
 * deduplicates on (source, target, type). Keying on the pair alone made a
 * DependsOn and an Invokes between the same two nodes collide, so one of them was
 * invisible to the diff.
 */
function edgeKey(e: GraphEdge): string {
    return `${e.sourceId}->${e.targetId}:${e.type}`;
}

export class BehavioralDiffEngine {

    public computeDiff(oldGraph: BehavioralGraph, newGraph: BehavioralGraph): DiffReport {
        const oldNodesMap = new Map(oldGraph.getNodes().map(n => [n.id, n]));
        const newNodesMap = new Map(newGraph.getNodes().map(n => [n.id, n]));

        const addedNodes: GraphNode[] = [];
        const removedNodes: GraphNode[] = [];
        const modifiedNodes: GraphNode[] = [];

        newNodesMap.forEach((node, id) => {
            const before = oldNodesMap.get(id);
            if (!before) {
                addedNodes.push(node);
                return;
            }
            // Only a comparison where both sides carry a hash is meaningful; a missing
            // hash means "not computed", not "unchanged".
            if (before.bodyHash && node.bodyHash && before.bodyHash !== node.bodyHash) {
                modifiedNodes.push(node);
            }
        });

        oldNodesMap.forEach((node, id) => {
            if (!newNodesMap.has(id)) removedNodes.push(node);
        });

        // Set membership rather than `includes` inside `filter`: the previous form was
        // O(n²) over edge lists that reach six figures on a mid-sized repo.
        const oldEdgeKeys = new Set(oldGraph.getEdges().map(edgeKey));
        const newEdgeKeys = new Set(newGraph.getEdges().map(edgeKey));

        const addedEdges = newGraph.getEdges().filter(e => !oldEdgeKeys.has(edgeKey(e)));
        const removedEdges = oldGraph.getEdges().filter(e => !newEdgeKeys.has(edgeKey(e)));

        // Impacted nodes for risk scoring:
        //   1. Every added node — an isolated new file still ships behavior.
        //   2. Every node whose body changed.
        //   3. Every node touched by an added or removed edge.
        //   4. Only nodes present in the *current* head graph qualify, so tombstones
        //      from a parent tree cannot leak risk into the output.
        const impacted: Map<string, GraphNode> = new Map();
        for (const n of addedNodes) impacted.set(n.id, n);
        for (const n of modifiedNodes) impacted.set(n.id, n);

        for (const e of [...addedEdges, ...removedEdges]) {
            const source = newNodesMap.get(e.sourceId);
            if (source) impacted.set(source.id, source);
            const target = newNodesMap.get(e.targetId);
            if (target) impacted.set(target.id, target);
        }

        return {
            addedNodes,
            removedNodes,
            modifiedNodes,
            addedEdges,
            removedEdges,
            impactedNodes: Array.from(impacted.values())
        };
    }
}
