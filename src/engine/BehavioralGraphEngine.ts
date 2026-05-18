import { RepositoryIntelligenceReport } from '../models/EntityModels';
import { BehavioralGraph, NodeType, EdgeType } from '../models/GraphModels';

/**
 * Phase 2: Semantic Understanding & Behavioral Graph Engine
 * Builds nodes from classes/methods/functions and emits:
 *  - DependsOn edges from imports (file-level coupling)
 *  - Invokes edges from CallExpression name matches (method/function callees)
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

        // 2. DependsOn edges via imports (file-level coupling)
        report.files.forEach(file => {
            const imports = report.dependencyMap[file.filePath];
            if (!imports) return;

            file.classes.forEach(sourceCls => {
                const sourceId = `${file.filePath}::${sourceCls.name}`;
                imports.forEach(imp => {
                    const baseImpName = imp.split('/').pop() || imp;
                    const targetFile = report.files.find(f =>
                        f.filePath.endsWith(`${baseImpName}.ts`) || f.filePath.endsWith(`${baseImpName}.js`)
                    );
                    if (targetFile) {
                        targetFile.classes.forEach(targetCls => {
                            const targetId = `${targetFile.filePath}::${targetCls.name}`;
                            graph.addEdge({ sourceId, targetId, type: EdgeType.DependsOn });
                        });
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
