/**
 * Nodes in the Behavioral Graph
 */
export enum NodeType {
    Service,
    Workflow,
    Method,
    Function,
    Schema
}

export interface GraphNode {
    id: string;
    type: NodeType;
    label: string;
    metadata?: any;
}

/**
 * Edges represent semantic relationships (e.g., invokes, mutates, depends_on)
 */
export enum EdgeType {
    Invokes = 'INVOKES',
    Mutates = 'MUTATES',
    Synchronizes = 'SYNCHRONIZES',
    DependsOn = 'DEPENDS_ON'
}

export interface GraphEdge {
    sourceId: string;
    targetId: string;
    type: EdgeType;
}

export class BehavioralGraph {
    private nodes: Map<string, GraphNode> = new Map();
    private edges: GraphEdge[] = [];
    private edgeKeys: Set<string> = new Set();

    public addNode(node: GraphNode): void {
        if (!this.nodes.has(node.id)) {
            this.nodes.set(node.id, node);
        }
    }

    /**
     * Dedup edges so the same (source, target, type) triple is recorded once.
     * This is critical for large monorepos where the same import resolves to
     * many basename-matched files; without dedup the edge count explodes.
     */
    public addEdge(edge: GraphEdge): void {
        const key = `${edge.sourceId}${edge.targetId}${edge.type}`;
        if (this.edgeKeys.has(key)) return;
        this.edgeKeys.add(key);
        this.edges.push(edge);
    }

    public getNodes(): GraphNode[] {
        return Array.from(this.nodes.values());
    }

    public getEdges(): GraphEdge[] {
        return this.edges;
    }
}
