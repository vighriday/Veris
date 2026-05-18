import { BehavioralGraph } from '../models/GraphModels';
import { DiffReport, RiskReport } from '../models/RiskModels';
import { loadRiskConfig, RiskConfig } from '../data/DataLoader';

/**
 * Risk scoring. Every weight, multiplier, and pattern is loaded from
 * data/risk-config.json (override-able at .veris/data/risk-config.json).
 * No magic numbers in code. Every score line has a corresponding explanation.
 */

function pathSegments(nodeId: string): string[] {
    const filePath = nodeId.split('::')[0].toLowerCase();
    return filePath.split(/[\\\/]/).filter(Boolean);
}

function dependencyFragilityScore(integrationCount: number, coeff: number): number {
    if (integrationCount <= 1) return 10;
    const score = coeff * Math.log2(integrationCount + 1);
    return Math.max(0, Math.min(100, Math.round(score)));
}

function runtimeCriticalityScore(
    nodeLabel: string, nodeId: string, cfg: RiskConfig['risk']
): { score: number; reasons: string[] } {
    let score = cfg.criticalityBase;
    const reasons: string[] = [];
    const enginePattern = new RegExp(cfg.patterns.enginePattern, 'i');
    const highImpactPattern = new RegExp(cfg.patterns.highImpactPattern, 'i');
    if (enginePattern.test(nodeLabel)) {
        score += cfg.criticalityEnginePatternBonus;
        reasons.push(`symbol name suggests a service-class path (/${cfg.patterns.enginePattern}/i)`);
    }
    if (highImpactPattern.test(nodeLabel)) {
        score += cfg.criticalityHighImpactPatternBonus;
        reasons.push(`symbol name suggests a high-impact behavior (auth/payment/webhook/migration)`);
    }
    const segs = pathSegments(nodeId);
    const hit = cfg.patterns.highImpactPathSegments.find(s => segs.includes(s));
    if (hit) {
        score += cfg.criticalityHighImpactPathBonus;
        reasons.push(`lives under a high-impact directory ('${hit}')`);
    }
    return { score: Math.min(cfg.criticalityMax, score), reasons };
}

export class RiskModelingEngine {

    constructor(private projectRoot: string = process.cwd()) {}

    public assessRisk(diff: DiffReport, currentGraph: BehavioralGraph): RiskReport[] {
        const cfg = loadRiskConfig(this.projectRoot).risk;
        const reports: RiskReport[] = [];

        const edgeIndex = new Map<string, number>();
        for (const e of currentGraph.getEdges()) {
            edgeIndex.set(e.sourceId, (edgeIndex.get(e.sourceId) || 0) + 1);
            edgeIndex.set(e.targetId, (edgeIndex.get(e.targetId) || 0) + 1);
        }

        for (const node of diff.impactedNodes) {
            const integrationCount = edgeIndex.get(node.id) || 0;
            const blastRadius = Math.min(integrationCount * cfg.blastRadiusPerEdge, cfg.blastRadiusMax);
            const fragility = dependencyFragilityScore(integrationCount, cfg.fragilityLog2Coefficient);
            const crit = runtimeCriticalityScore(node.label, node.id, cfg);

            const overallRisk = parseFloat(
                (cfg.weights.blastRadius * blastRadius +
                 cfg.weights.runtimeCriticality * crit.score +
                 cfg.weights.dependencyFragility * fragility).toFixed(2)
            );

            const explanations: string[] = [];
            explanations.push(`Node '${node.label}' was identified as impacted by structural / edge changes.`);
            if (integrationCount > 0) {
                explanations.push(`Has ${integrationCount} graph integration${integrationCount === 1 ? '' : 's'} (DependsOn or Invokes).`);
            }
            if (blastRadius >= 50) {
                explanations.push(`Blast radius ${blastRadius}/100 — change ripples across many neighbors.`);
            }
            if (fragility >= 60) {
                explanations.push(`Dependency fragility ${fragility}/100 — densely coupled.`);
            }
            for (const r of crit.reasons) explanations.push(`Runtime criticality: ${r}.`);
            if (crit.score >= 80) {
                explanations.push(`Runtime criticality ${crit.score}/100 — high.`);
            }

            reports.push({
                nodeId: node.id,
                score: {
                    blastRadius,
                    runtimeCriticality: crit.score,
                    integrationCount,
                    dependencyFragility: fragility,
                    overallRisk,
                    explanation: explanations
                }
            });
        }

        return reports;
    }
}
