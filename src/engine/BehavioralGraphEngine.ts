import { RepositoryIntelligenceReport, VerisFile } from '../models/EntityModels';
import { BehavioralGraph, NodeType, EdgeType, EdgeResolution } from '../models/GraphModels';

/**
 * Behavioral Graph Engine.
 *
 * Nodes: classes, methods, constructors, accessors, top-level functions.
 * Edges:
 *   - DependsOn (structural): containment, and file-level coupling from imports.
 *   - Invokes: call targets already resolved by the intelligence engine. An edge is
 *     emitted only for a `resolved` or `heuristic` call — an ambiguous name yields
 *     no edge at all, rather than one edge per same-named declaration.
 */

/** Extensions an import specifier may carry that the file index does not. */
const SPECIFIER_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/i;

/** Normalizes a filename or import specifier tail to a comparable basename. */
function normalizeBase(value: string): string {
    let v = value.replace(SPECIFIER_EXT, '');
    if (v.endsWith('/index')) v = v.slice(0, -'/index'.length);
    const tail = v.split('/').pop() || v;
    return tail.toLowerCase();
}

export class BehavioralGraphEngine {

    public buildGraphFromReport(report: RepositoryIntelligenceReport): BehavioralGraph {
        const graph = new BehavioralGraph();

        const fileByBaseName: Map<string, VerisFile[]> = new Map();
        for (const f of report.files) {
            const base = normalizeBase(f.filePath);
            if (!base) continue;
            const list = fileByBaseName.get(base);
            if (list) list.push(f); else fileByBaseName.set(base, [f]);
        }

        // 1. Nodes
        for (const file of report.files) {
            for (const cls of file.classes) {
                const classNodeId = `${file.filePath}::${cls.name}`;
                graph.addNode({ id: classNodeId, type: NodeType.Service, label: cls.name });

                for (const method of cls.methods) {
                    const methodNodeId = `${classNodeId}::${method.name}`;
                    graph.addNode({
                        id: methodNodeId,
                        type: NodeType.Method,
                        label: method.name,
                        bodyHash: method.bodyHash,
                        metadata: method.kind ? { kind: method.kind } : undefined
                    });
                    graph.addEdge({
                        sourceId: classNodeId, targetId: methodNodeId,
                        type: EdgeType.DependsOn, resolution: 'structural'
                    });
                }
            }

            for (const fn of file.functions) {
                graph.addNode({
                    id: `${file.filePath}::${fn.name}`,
                    type: NodeType.Function,
                    label: fn.name,
                    bodyHash: fn.bodyHash
                });
            }
        }

        const nodeIds = new Set(graph.getNodes().map(n => n.id));

        // 2. DependsOn from imports.
        //
        // Read from `file.imports`, not `report.dependencyMap`. The map was keyed by a
        // path that desynchronized from `filePath` whenever the analysis root differed
        // from the reporting root — which is exactly the base-snapshot case, so the
        // base graph came out with zero import edges on every run and every import
        // relationship was reported as newly added.
        const isLocalImportSpec = (imp: string): boolean =>
            !!imp && (imp.startsWith('.') || imp.startsWith('/') || imp.startsWith('~/') ||
                      imp.startsWith('@/') || imp.startsWith('$/'));

        for (const file of report.files) {
            if (file.classes.length === 0) continue;
            for (const imp of file.imports) {
                if (!isLocalImportSpec(imp)) continue;
                // Both sides go through the same normalizer. Previously the file index
                // stripped extensions but the specifier did not, so `from './target.js'`
                // never matched `target` — zero import edges in any ESM/NodeNext repo.
                const baseImpName = normalizeBase(imp);
                if (!baseImpName) continue;
                const targetFiles = fileByBaseName.get(baseImpName);
                if (!targetFiles || targetFiles.length > 5) continue;

                for (const sourceCls of file.classes) {
                    const sourceId = `${file.filePath}::${sourceCls.name}`;
                    for (const targetFile of targetFiles) {
                        if (targetFile.filePath === file.filePath) continue;
                        for (const targetCls of targetFile.classes) {
                            graph.addEdge({
                                sourceId,
                                targetId: `${targetFile.filePath}::${targetCls.name}`,
                                type: EdgeType.DependsOn,
                                resolution: 'structural'
                            });
                        }
                    }
                }
            }
        }

        // 3. Invokes from resolved call targets.
        const addInvokes = (sourceId: string, calls: VerisFile['functions'][number]['calls']) => {
            for (const call of calls || []) {
                if (!call.targetId) continue;
                if (call.resolution !== 'resolved' && call.resolution !== 'heuristic') continue;
                if (call.targetId === sourceId) continue;
                if (!nodeIds.has(call.targetId)) continue;
                graph.addEdge({
                    sourceId,
                    targetId: call.targetId,
                    type: EdgeType.Invokes,
                    resolution: call.resolution as EdgeResolution
                });
            }
        };

        for (const file of report.files) {
            for (const cls of file.classes) {
                const classNodeId = `${file.filePath}::${cls.name}`;
                for (const method of cls.methods) {
                    addInvokes(`${classNodeId}::${method.name}`, method.calls);
                }
            }
            for (const fn of file.functions) {
                addInvokes(`${file.filePath}::${fn.name}`, fn.calls);
            }
        }

        return graph;
    }
}
