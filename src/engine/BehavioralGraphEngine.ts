import { RepositoryIntelligenceReport, VerisFile } from '../models/EntityModels';
import { BehavioralGraph, NodeType, EdgeType } from '../models/GraphModels';

/**
 * Behavioral Graph Engine.
 *
 * Nodes: classes, methods, functions.
 * Edges:
 *   - DependsOn: file-level coupling from `import`/`require()` chains.
 *   - Invokes:   resolved from CallExpression names against a callable index.
 *
 * Perf: file lookup by basename is O(1) via Map (previously O(N) per import,
 * which exploded to O(N²) on monorepos with thousands of files).
 */
export class BehavioralGraphEngine {

    public buildGraphFromReport(report: RepositoryIntelligenceReport): BehavioralGraph {
        const graph = new BehavioralGraph();

        // Index callable nodes by short name for cross-file invoke resolution
        const calleeIndex: Map<string, string[]> = new Map();
        const indexCallable = (name: string, nodeId: string) => {
            const list = calleeIndex.get(name) || [];
            list.push(nodeId);
            calleeIndex.set(name, list);
        };

        // Index files by basename (without extension) and by lowercased basename
        // for fast cross-file resolution of imports.
        const fileByBaseName: Map<string, VerisFile[]> = new Map();
        for (const f of report.files) {
            const segs = f.filePath.split(/[\\\/]/);
            const last = segs[segs.length - 1] || '';
            const base = last.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/i, '').toLowerCase();
            if (!base) continue;
            const list = fileByBaseName.get(base) || [];
            list.push(f);
            fileByBaseName.set(base, list);
        }

        // 1. Nodes
        report.files.forEach(file => {
            file.classes.forEach(cls => {
                const classNodeId = `${file.filePath}::${cls.name}`;
                graph.addNode({ id: classNodeId, type: NodeType.Service, label: cls.name });

                cls.methods.forEach(method => {
                    const methodNodeId = `${classNodeId}::${method.name}`;
                    graph.addNode({ id: methodNodeId, type: NodeType.Method, label: method.name });
                    graph.addEdge({ sourceId: classNodeId, targetId: methodNodeId, type: EdgeType.DependsOn });
                    indexCallable(method.name, methodNodeId);
                });
            });

            file.functions.forEach(fn => {
                const funcNodeId = `${file.filePath}::${fn.name}`;
                graph.addNode({ id: funcNodeId, type: NodeType.Function, label: fn.name });
                indexCallable(fn.name, funcNodeId);
            });
        });

        // 2. DependsOn edges via imports (file-level coupling, basename-indexed).
        // Heuristic: only count edges for imports that look like relative paths
        // (starts with '.', '..', '/', or '~/') OR a TS path-alias-shaped specifier.
        // Bare package imports like 'fs', 'express', 'lodash' don't create graph edges.
        const isLocalImportSpec = (imp: string): boolean => {
            if (!imp) return false;
            if (imp.startsWith('.') || imp.startsWith('/') || imp.startsWith('~/')) return true;
            // TS path aliases (Next.js, NestJS): @/foo, ~/foo, $foo/bar etc. — let basename win.
            if (imp.startsWith('@/') || imp.startsWith('$/')) return true;
            return false;
        };

        report.files.forEach(file => {
            const imports = report.dependencyMap[file.filePath];
            if (!imports) return;

            file.classes.forEach(sourceCls => {
                const sourceId = `${file.filePath}::${sourceCls.name}`;
                imports.forEach(imp => {
                    if (!isLocalImportSpec(imp)) return;
                    const baseImpName = (imp.split('/').pop() || imp).toLowerCase();
                    if (!baseImpName) return;
                    const targetFiles = fileByBaseName.get(baseImpName);
                    if (!targetFiles) return;
                    // Cap basename collisions: if more than 5 files share a basename,
                    // skip — almost certainly a generic name (e.g. 'index', 'utils')
                    // that would just create noise edges.
                    if (targetFiles.length > 5) return;
                    for (const targetFile of targetFiles) {
                        if (targetFile.filePath === file.filePath) continue;
                        for (const targetCls of targetFile.classes) {
                            const targetId = `${targetFile.filePath}::${targetCls.name}`;
                            graph.addEdge({ sourceId, targetId, type: EdgeType.DependsOn });
                        }
                    }
                });
            });
        });

        // 3. Invokes edges from CallExpression analysis
        report.files.forEach(file => {
            file.classes.forEach(cls => {
                const classNodeId = `${file.filePath}::${cls.name}`;
                cls.methods.forEach(method => {
                    const methodNodeId = `${classNodeId}::${method.name}`;
                    (method.calls || []).forEach(callee => {
                        const targets = calleeIndex.get(callee);
                        if (!targets) return;
                        targets.forEach(targetId => {
                            if (targetId === methodNodeId) return;
                            graph.addEdge({ sourceId: methodNodeId, targetId, type: EdgeType.Invokes });
                        });
                    });
                });
            });

            file.functions.forEach(fn => {
                const funcNodeId = `${file.filePath}::${fn.name}`;
                (fn.calls || []).forEach(callee => {
                    const targets = calleeIndex.get(callee);
                    if (!targets) return;
                    targets.forEach(targetId => {
                        if (targetId === funcNodeId) return;
                        graph.addEdge({ sourceId: funcNodeId, targetId, type: EdgeType.Invokes });
                    });
                });
            });
        });

        return graph;
    }
}
