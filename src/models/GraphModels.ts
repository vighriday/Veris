import { BVIFile, BVIClass, BVIFunction } from './EntityModels';

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

    public addNode(node: GraphNode): void {
        if (!this.nodes.has(node.id)) {
            this.nodes.set(node.id, node);
        }
    }

    public addEdge(edge: GraphEdge): void {
        this.edges.push(edge);
    }

    public getNodes(): GraphNode[] {
        return Array.from(this.nodes.values());
    }

    public getEdges(): GraphEdge[] {
        return this.edges;
    }
}
