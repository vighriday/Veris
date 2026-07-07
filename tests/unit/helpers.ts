import { BehavioralGraph, GraphNode, NodeType, EdgeType } from '../../src/models/GraphModels';
import { RiskReport } from '../../src/models/RiskModels';
import { VerificationPlan, VerificationTarget, VerificationTier } from '../../src/models/VerificationModels';
import { RepositoryIntelligenceReport, VerisFile } from '../../src/models/EntityModels';
import { WorkflowDomain, WorkflowKind } from '../../src/models/WorkflowModels';

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

/** Build a function entity. */
export function fn(name: string, calls: string[] = []): VerisFile['functions'][number] {
    return { name, isExported: true, calls };
}

/** Build a class entity with methods. */
export function cls(name: string, methods: string[] = []): VerisFile['classes'][number] {
    return { name, methods: methods.map(m => fn(m)) };
}

/** Build a VerisFile. */
export function file(
    filePath: string,
    opts: { classes?: VerisFile['classes']; functions?: VerisFile['functions']; imports?: string[] } = {}
): VerisFile {
    return {
        filePath,
        classes: opts.classes ?? [],
        functions: opts.functions ?? [],
        imports: opts.imports ?? [],
    };
}

/** Build a RepositoryIntelligenceReport. dependencyMap defaults to each file's imports. */
export function repo(files: VerisFile[], projectPath = '/tmp/veris-test'): RepositoryIntelligenceReport {
    const dependencyMap: Record<string, string[]> = {};
    for (const f of files) dependencyMap[f.filePath] = f.imports;
    return { projectPath, files, dependencyMap };
}

/** Build a WorkflowDomain. */
export function domain(
    id: string,
    kind: WorkflowKind,
    memberNodeIds: string[],
    confidence = 80
): WorkflowDomain {
    return { id, name: kind, kind, memberNodeIds, signals: [], confidence };
}
