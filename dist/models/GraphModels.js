"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BehavioralGraph = exports.EdgeType = exports.NodeType = void 0;
/**
 * Nodes in the Behavioral Graph
 */
var NodeType;
(function (NodeType) {
    NodeType[NodeType["Service"] = 0] = "Service";
    NodeType[NodeType["Workflow"] = 1] = "Workflow";
    NodeType[NodeType["Method"] = 2] = "Method";
    NodeType[NodeType["Function"] = 3] = "Function";
    NodeType[NodeType["Schema"] = 4] = "Schema";
})(NodeType || (exports.NodeType = NodeType = {}));
/**
 * Edges represent semantic relationships (e.g., invokes, mutates, depends_on)
 */
var EdgeType;
(function (EdgeType) {
    EdgeType["Invokes"] = "INVOKES";
    EdgeType["Mutates"] = "MUTATES";
    EdgeType["Synchronizes"] = "SYNCHRONIZES";
    EdgeType["DependsOn"] = "DEPENDS_ON";
})(EdgeType || (exports.EdgeType = EdgeType = {}));
class BehavioralGraph {
    nodes = new Map();
    edges = [];
    addNode(node) {
        if (!this.nodes.has(node.id)) {
            this.nodes.set(node.id, node);
        }
    }
    addEdge(edge) {
        this.edges.push(edge);
    }
    getNodes() {
        return Array.from(this.nodes.values());
    }
    getEdges() {
        return this.edges;
    }
}
exports.BehavioralGraph = BehavioralGraph;
