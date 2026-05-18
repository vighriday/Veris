import { BehavioralGraph, GraphNode } from '../models/GraphModels';
import { DiffReport, RiskReport } from '../models/RiskModels';
import { BehavioralDiffEngine } from './BehavioralDiffEngine';
import { RiskModelingEngine } from './RiskModelingEngine';

/**
 * Counterfactual mode answers "what if we removed / reverted this change?".
 *
 * Given the head graph and a set of node ids to hypothetically remove, build a
 * synthetic graph without those nodes and re-run diff + risk against the real base.
 * Returns: the would-be risk profile, plus deltas vs the actual head profile.
 *
 * This lets a developer ask: "If I revert my changes to X, what behaviors recover?"
 */
export interface CounterfactualResult {
    removedNodeIds: string[];
    actualHeadRisk: number;
    counterfactualRisk: number;
    delta: number;                       // positive = risk drops if reverted
    actualImpacted: number;
    counterfactualImpacted: number;
    impactedDelta: number;
    risksAvoided: RiskReport[];
    narrative: string;
}

export class CounterfactualEngine {
    private diff = new BehavioralDiffEngine();
    private risk: RiskModelingEngine;
    constructor(projectRoot: string = process.cwd()) {
        this.risk = new RiskModelingEngine(projectRoot);
    }

    public whatIfRevert(
        baseGraph: BehavioralGraph,
        headGraph: BehavioralGraph,
        removeNodeIds: string[]
    ): CounterfactualResult {
        const remove = new Set(removeNodeIds);

        // Actual profile
        const actualDiff = this.diff.computeDiff(baseGraph, headGraph);
        const actualRisks = this.risk.assessRisk(actualDiff, headGraph);
        const actualAvg = actualRisks.length === 0 ? 0
            : actualRisks.reduce((s, r) => s + r.score.overallRisk, 0) / actualRisks.length;

        // Counterfactual: head minus the specified nodes
        const cfGraph = new BehavioralGraph();
        for (const n of headGraph.getNodes()) if (!remove.has(n.id)) cfGraph.addNode(n);
        for (const e of headGraph.getEdges()) {
            if (!remove.has(e.sourceId) && !remove.has(e.targetId)) cfGraph.addEdge(e);
        }
        const cfDiff = this.diff.computeDiff(baseGraph, cfGraph);
        const cfRisks = this.risk.assessRisk(cfDiff, cfGraph);
        const cfAvg = cfRisks.length === 0 ? 0
            : cfRisks.reduce((s, r) => s + r.score.overallRisk, 0) / cfRisks.length;

        // Risks present in actual but absent or reduced in counterfactual
        const cfRiskMap = new Map(cfRisks.map(r => [r.nodeId, r]));
        const avoided = actualRisks.filter(r => {
            const cf = cfRiskMap.get(r.nodeId);
            return !cf || cf.score.overallRisk < r.score.overallRisk - 5;
        });

        const delta = actualAvg - cfAvg;
        const impactedDelta = actualDiff.impactedNodes.length - cfDiff.impactedNodes.length;
        const narrative = buildCounterfactualNarrative(removeNodeIds.length, actualAvg, cfAvg, delta, impactedDelta, avoided.length);

        return {
            removedNodeIds: [...remove],
            actualHeadRisk: parseFloat(actualAvg.toFixed(2)),
            counterfactualRisk: parseFloat(cfAvg.toFixed(2)),
            delta: parseFloat(delta.toFixed(2)),
            actualImpacted: actualDiff.impactedNodes.length,
            counterfactualImpacted: cfDiff.impactedNodes.length,
            impactedDelta,
            risksAvoided: avoided.slice(0, 10),
            narrative
        };
    }
}

function buildCounterfactualNarrative(n: number, actual: number, cf: number, delta: number, impactedDelta: number, avoided: number): string {
    if (delta <= 0.5) {
        return `Reverting ${n} node${n === 1 ? '' : 's'} does not measurably reduce risk (delta ${delta.toFixed(1)}). The risk concentrates elsewhere.`;
    }
    return `Reverting ${n} node${n === 1 ? '' : 's'} would drop average risk from ${actual.toFixed(1)} to ${cf.toFixed(1)} (delta -${delta.toFixed(1)}). ${impactedDelta} fewer impacted node${impactedDelta === 1 ? '' : 's'}; ${avoided} elevated risk${avoided === 1 ? '' : 's'} avoided.`;
}
