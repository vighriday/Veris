import { RepositoryIntelligenceReport, BVIFile } from '../models/EntityModels';
import { BehavioralGraph, NodeType, EdgeType } from '../models/GraphModels';

/**
 * Phase 2: Semantic Understanding & Behavioral Graph Engine
 * Uses the AST mappings to create Behavioral Workflows, state dependencies, etc.
 */
export class BehavioralGraphEngine {
    
    public buildGraphFromReport(report: RepositoryIntelligenceReport): BehavioralGraph {
        const graph = new BehavioralGraph();

        // 1. First Pass: Map entities to Nodes
        report.files.forEach(file => {
            file.classes.forEach(cls => {
                const classNodeId = `${file.filePath}::${cls.name}`;
                graph.addNode({
                    id: classNodeId,
                    type: NodeType.Service,
                    label: cls.name
                });

                cls.methods.forEach(method => {
                    const methodNodeId = `${classNodeId}::${method.name}`;
                    graph.addNode({
                        id: methodNodeId,
                        type: NodeType.Method,
                        label: method.name
                    });

                    // Class -> Method dependency (DependsOn)
                    graph.addEdge({
                        sourceId: classNodeId,
                        targetId: methodNodeId,
                        type: EdgeType.DependsOn
                    });
                });
            });

            file.functions.forEach(fn => {
                const funcNodeId = `${file.filePath}::${fn.name}`;
                graph.addNode({
                    id: funcNodeId,
                    type: NodeType.Function,
                    label: fn.name
                });
            });
        });

        // 2. Second Pass: Infer Workflow Relationships (simplified)
        // Here we simulate semantic understanding by mapping File imports to edges between nodes in those files.
        // In a full implementation, AST traversal tracks exact function call expressions (CallExpression) to other files.
        report.files.forEach(file => {
            const imports = report.dependencyMap[file.filePath];
            if (!imports) return;
            
            // Map file-level dependencies (heuristic for "depends_on" or "invokes")
            file.classes.forEach(sourceCls => {
                const sourceId = `${file.filePath}::${sourceCls.name}`;
                
                imports.forEach(imp => {
                    // Extract the base module name ignoring local dot slashes
                    const baseImpName = imp.split('/').pop() || imp;
                    const targetFile = report.files.find(f => f.filePath.endsWith(`${baseImpName}.ts`) || f.filePath.endsWith(`${baseImpName}.js`));
                    if (targetFile) {
                        targetFile.classes.forEach(targetCls => {
                            const targetId = `${targetFile.filePath}::${targetCls.name}`;
                            graph.addEdge({
                                sourceId,
                                targetId,
                                type: EdgeType.DependsOn
                            });
                        });
                    }
                });
            });
        });

        return graph;
    }
}
