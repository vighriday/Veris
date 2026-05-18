"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RiskModelingEngine = void 0;
class RiskModelingEngine {
    assessRisk(diff, currentGraph) {
        const reports = [];
        diff.impactedNodes.forEach(node => {
            // Calculate integrations (edges connected to this node)
            const relatedEdges = currentGraph.getEdges().filter(e => e.sourceId === node.id || e.targetId === node.id);
            const integrationCount = relatedEdges.length;
            // Simplified scoring logic
            const blastRadius = Math.min(integrationCount * 10, 100);
            const runtimeCriticality = node.label.includes('Engine') || node.label.toLowerCase().includes('auth') ? 90 : 30; // Heuristic
            const dependencyFragility = integrationCount > 5 ? 80 : 20;
            const overallRisk = (blastRadius + runtimeCriticality + dependencyFragility) / 3;
            // Explainability Layer
            const explanations = [];
            explanations.push(`Node '${node.label}' was identified as impacted by structural/edge changes.`);
            if (blastRadius > 50)
                explanations.push(`High blast radius due to ${integrationCount} integrations.`);
            if (runtimeCriticality > 80)
                explanations.push(`High runtime criticality assigned (core engine or auth path).`);
            if (dependencyFragility > 50)
                explanations.push(`High dependency fragility due to dense coupling.`);
            reports.push({
                nodeId: node.id,
                score: {
                    blastRadius,
                    runtimeCriticality,
                    integrationCount,
                    dependencyFragility,
                    overallRisk: parseFloat(overallRisk.toFixed(2)),
                    explanation: explanations
                }
            });
        });
        return reports;
    }
}
exports.RiskModelingEngine = RiskModelingEngine;
