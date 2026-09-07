import { BehavioralGraph, GraphNode, NodeType, EdgeType } from '../../src/models/GraphModels';
import { RiskReport } from '../../src/models/RiskModels';
import { VerificationPlan, VerificationTarget, VerificationTier } from '../../src/models/VerificationModels';
import { RepositoryIntelligenceReport, VerisFile, CallRef, CallResolution, AnalysisStats } from '../../src/models/EntityModels';
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

/**
 * Build a function entity.
 *
 * `calls` are resolved **target node ids** (`src/b.ts::doWork`), not bare names —
 * the graph engine consumes resolved targets, so a helper taking names would let a
 * test pass against a contract the engine no longer offers.
 */
export function fn(
    name: string,
    calls: string[] = [],
    opts: { bodyHash?: string; resolution?: CallResolution } = {}
): VerisFile['functions'][number] {
    return {
        name,
        isExported: true,
        bodyHash: opts.bodyHash,
        calls: calls.map(targetId => ({
            name: targetId.split('::').pop() ?? targetId,
            targetId,
            resolution: opts.resolution ?? 'resolved',
        })),
    };
}

/** A call the checker could not resolve and that matches several declarations. */
export function ambiguousCall(name: string): CallRef {
    return { name, targetId: null, resolution: 'ambiguous' };
}

/** Build a class entity with methods. */
export function cls(name: string, methods: string[] = []): VerisFile['classes'][number] {
    return { name, methods: methods.map(m => fn(m)) };
}

/** Build a VerisFile. `filePath` is project-root-relative, as in real reports. */
export function file(
    filePath: string,
    opts: { classes?: VerisFile['classes']; functions?: VerisFile['functions']; imports?: string[] } = {}
): VerisFile {
    return {
        filePath,
        absPath: `/tmp/veris-test/${filePath}`,
        classes: opts.classes ?? [],
        functions: opts.functions ?? [],
        imports: opts.imports ?? [],
    };
}

export function stats(over: Partial<AnalysisStats> = {}): AnalysisStats {
    return {
        filesAnalyzed: 0, filesSkipped: 0,
        callsResolved: 0, callsHeuristic: 0, callsAmbiguous: 0, callsExternal: 0,
        truncated: false,
        ...over,
    };
}

/** Build a RepositoryIntelligenceReport. dependencyMap defaults to each file's imports. */
export function repo(files: VerisFile[], projectPath = '/tmp/veris-test'): RepositoryIntelligenceReport {
    const dependencyMap: Record<string, string[]> = {};
    for (const f of files) dependencyMap[f.filePath] = f.imports;
    return { projectPath, files, dependencyMap, stats: stats({ filesAnalyzed: files.length }) };
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
