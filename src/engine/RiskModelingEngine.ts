import { BehavioralGraph, EdgeType, GraphEdge } from '../models/GraphModels';
import { DiffReport, RiskReport } from '../models/RiskModels';
import { loadRiskConfig, RiskConfig } from '../data/DataLoader';

/**
 * Risk scoring. Three inputs, each measuring something the other two do not:
 *
 *   blastRadius          how much coupling the node has     (magnitude)
 *   dependencyFragility  which way that coupling points     (direction)
 *   runtimeCriticality   what the node appears to do        (name + location)
 *
 * The previous model spent 65% of the score on node degree twice — a linear
 * `min(8 × degree, 100)` blast radius plus a `18·log2(degree + 1)` "fragility"
 * that was a monotone transform of the same scalar. Two terms, one measurement.
 * That linear term also hit its ceiling at degree 13, so a 13-edge node and a
 * 500-edge node scored identically.
 *
 * `RiskScore.dependencyFragility` now carries inbound-coupling dominance. The
 * field name predates the change and lives in the shared model, so the
 * explanation strings name the measurement rather than the field.
 *
 * Every weight that tunes the score lives in data/risk-config.json (override at
 * .veris/data/risk-config.json). The smoothing prior and the balance point in
 * `inboundDominance` describe what a share *is* — they are not tuning knobs, so
 * they stay in code.
 */

/** How a node is coupled to the rest of the graph. Containment is not coupling. */
interface Coupling {
    fanIn: number;
    fanOut: number;
    /** Edges whose target was matched by name rather than resolved by the checker. */
    heuristic: number;
    /** Containment edges seen and deliberately not counted — reported, not scored. */
    containment: number;
}

/** Shared stand-in for a node with no edges. Frozen: it is handed to every caller. */
const ZERO_COUPLING: Readonly<Coupling> = Object.freeze({ fanIn: 0, fanOut: 0, heuristic: 0, containment: 0 });

/**
 * A class -> own-method edge: the class *having* a member, not an integration
 * with anything. Counting it made degree scale with class size, so a service
 * with 20 methods scored as if 20 things depended on it.
 *
 * Detected by id shape — a member id is its owner's id plus `::name` — rather
 * than by `resolution`, because import edges are `structural` too and those are
 * real integrations.
 */
function isContainmentEdge(edge: GraphEdge): boolean {
    return edge.type === EdgeType.DependsOn && edge.targetId.startsWith(edge.sourceId + '::');
}

function buildCouplingIndex(graph: BehavioralGraph): Map<string, Coupling> {
    const index = new Map<string, Coupling>();
    const entry = (id: string): Coupling => {
        let c = index.get(id);
        if (!c) { c = { fanIn: 0, fanOut: 0, heuristic: 0, containment: 0 }; index.set(id, c); }
        return c;
    };

    for (const edge of graph.getEdges()) {
        const source = entry(edge.sourceId);
        const target = entry(edge.targetId);
        if (isContainmentEdge(edge)) {
            source.containment++;
            target.containment++;
            continue;
        }
        source.fanOut++;
        target.fanIn++;
        if (edge.resolution === 'heuristic') {
            source.heuristic++;
            target.heuristic++;
        }
    }
    return index;
}

/**
 * Coupling magnitude, 0..`max`.
 *
 * `perEdge` is the slope at zero — roughly the value of the first edge — and
 * `max` is an asymptote the curve approaches instead of clamping to. The curve
 * is strictly increasing in degree, so it keeps separating a 20-edge node from a
 * 50-edge one where the old `min(perEdge × degree, max)` was flat from degree 13
 * upward. With the shipped constants (8, 100) it reads 27 at degree 4, 80 at 20,
 * 98 at 50, and only rounds to the ceiling near degree 68.
 */
function blastRadiusScore(degree: number, perEdge: number, max: number): number {
    if (degree <= 0 || max <= 0 || perEdge <= 0) return 0;
    return Math.round(max * (1 - Math.exp(-(perEdge * degree) / max)));
}

/**
 * Inbound coupling dominance, 0..100 — independent of `blastRadiusScore` by
 * construction: that one counts a node's edges, this one asks which way they
 * point. At equal degree, a node many things call is riskier to change than one
 * that calls many things, because the change propagates outward from it.
 */
function inboundDominance(fanIn: number, fanOut: number): number {
    // +1 per side (Laplace): a single inbound edge is weak evidence, not proof
    // that everything depends on this node.
    const share = (fanIn + 1) / (fanIn + fanOut + 2);
    // A share balances at 0.5 by definition. Only the inbound excess is a risk
    // signal, so a balanced or outbound-heavy node scores 0 rather than half.
    return Math.round(Math.max(0, 2 * share - 1) * 100);
}

function pathSegments(nodeId: string): string[] {
    const filePath = nodeId.split('::')[0].toLowerCase();
    return filePath.split(/[\\\/]/).filter(Boolean);
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
        const weights = cfg.weights;
        const coupling = buildCouplingIndex(currentGraph);
        const reports: RiskReport[] = [];

        for (const node of diff.impactedNodes) {
            const c = coupling.get(node.id) ?? ZERO_COUPLING;
            const integrationCount = c.fanIn + c.fanOut;
            const blastRadius = blastRadiusScore(integrationCount, cfg.blastRadiusPerEdge, cfg.blastRadiusMax);
            const dominance = inboundDominance(c.fanIn, c.fanOut);
            const crit = runtimeCriticalityScore(node.label, node.id, cfg);

            const overallRisk = parseFloat(
                (weights.blastRadius * blastRadius +
                 weights.runtimeCriticality * crit.score +
                 weights.dependencyFragility * dominance).toFixed(2)
            );

            const explanations: string[] = [];
            explanations.push(`Node '${node.label}' was identified as impacted by structural / edge changes.`);

            if (integrationCount === 0) {
                explanations.push(`No coupling edges in the current graph — blast radius 0/100.`);
            } else {
                explanations.push(
                    `Blast radius ${blastRadius}/100 — ${integrationCount} coupling edge${integrationCount === 1 ? '' : 's'} ` +
                    `(${c.fanIn} inbound, ${c.fanOut} outbound).`
                );
            }
            if (c.containment > 0) {
                explanations.push(
                    `${c.containment} class-member containment edge${c.containment === 1 ? '' : 's'} excluded from the count — ` +
                    `a class holding methods is structure, not integration.`
                );
            }
            explanations.push(dominance > 0
                ? `Inbound coupling dominance ${dominance}/100 — more coupling points at this node than away from it, so a change here propagates outward.`
                : `Inbound coupling dominance 0/100 — coupling is balanced or outbound-heavy.`);
            if (c.heuristic > 0) {
                explanations.push(
                    `${c.heuristic} of ${integrationCount} coupling edges are heuristic name matches rather than checker-resolved — ` +
                    `this node's connectivity is partly inferred.`
                );
            }
            for (const r of crit.reasons) explanations.push(`Runtime criticality: ${r}.`);
            explanations.push(`Runtime criticality ${crit.score}/100.`);
            explanations.push(
                `Overall risk ${overallRisk}/100 = ${weights.blastRadius} × blast radius + ` +
                `${weights.dependencyFragility} × inbound dominance + ${weights.runtimeCriticality} × runtime criticality.`
            );

            reports.push({
                nodeId: node.id,
                score: {
                    blastRadius,
                    runtimeCriticality: crit.score,
                    integrationCount,
                    dependencyFragility: dominance,
                    overallRisk,
                    explanation: explanations
                }
            });
        }

        return reports;
    }
}
