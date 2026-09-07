import { describe, it, expect } from 'vitest';
import { RiskModelingEngine } from '../../src/engine/RiskModelingEngine';
import { BehavioralDiffEngine } from '../../src/engine/BehavioralDiffEngine';
import { BehavioralGraphEngine } from '../../src/engine/BehavioralGraphEngine';
import { BehavioralGraph, EdgeType } from '../../src/models/GraphModels';
import { graph, repo, file, cls } from './helpers';

// projectRoot defaults to cwd; config resolves from the package data/ dir.
const engine = new RiskModelingEngine();
const differ = new BehavioralDiffEngine();

/** Score a graph as if every node in it were newly added. */
function assess(g: BehavioralGraph) {
    return engine.assessRisk(differ.computeDiff(graph([]), g), g);
}

/** A node with `fanIn` callers and `fanOut` callees, all non-containment edges. */
function hub(id: string, fanIn: number, fanOut: number) {
    const ids = [id];
    const edges: string[] = [];
    for (let i = 0; i < fanIn; i++) { ids.push('in' + i); edges.push('in' + i + '->' + id); }
    for (let i = 0; i < fanOut; i++) { ids.push('out' + i); edges.push(id + '->out' + i); }
    return assess(graph(ids, edges)).find(r => r.nodeId === id)!;
}

describe('RiskModelingEngine.assessRisk', () => {
    it('returns one report per impacted node', () => {
        const oldG = graph(['src/a.ts::a']);
        const newG = graph(['src/a.ts::a', 'src/b.ts::b'], ['src/a.ts::a->src/b.ts::b']);
        const diff = differ.computeDiff(oldG, newG);
        const reports = engine.assessRisk(diff, newG);
        const ids = reports.map(r => r.nodeId).sort();
        expect(ids).toEqual(['src/a.ts::a', 'src/b.ts::b']);
    });

    it('scores overallRisk in the 0..100 band with an explanation', () => {
        const oldG = graph([]);
        const newG = graph(['src/x.ts::x']);
        const diff = differ.computeDiff(oldG, newG);
        const [report] = engine.assessRisk(diff, newG);
        expect(report.score.overallRisk).toBeGreaterThanOrEqual(0);
        expect(report.score.overallRisk).toBeLessThanOrEqual(100);
        expect(report.score.explanation.length).toBeGreaterThan(0);
    });

    it('scores a payment-path node higher than a plain util node', () => {
        // Same structure (isolated new node), different path/label. The
        // high-impact directory + symbol bonuses must lift the payment node.
        const build = (id: string) => {
            const diff = differ.computeDiff(graph([]), graph([id]));
            return engine.assessRisk(diff, graph([id]))[0];
        };
        const payment = build('src/payments/charge.ts::chargeCard');
        const util = build('src/utils/format.ts::pad');
        expect(payment.score.runtimeCriticality).toBeGreaterThan(util.score.runtimeCriticality);
        expect(payment.score.overallRisk).toBeGreaterThan(util.score.overallRisk);
    });

    it('raises blast radius with more graph integrations', () => {
        // Hub node with many edges should carry a larger blast radius than a
        // leaf node with one.
        const hubId = 'src/core/hub.ts::hub';
        const nodes = [hubId, 'a', 'b', 'c', 'd'];
        const edges = ['a->' + hubId, 'b->' + hubId, 'c->' + hubId, 'd->' + hubId];
        const g = graph(nodes, edges);
        const diff = differ.computeDiff(graph([]), g);
        const reports = engine.assessRisk(diff, g);
        const hubReport = reports.find(r => r.nodeId === hubId)!;
        const leafReport = reports.find(r => r.nodeId === 'a')!;
        expect(hubReport.score.blastRadius).toBeGreaterThan(leafReport.score.blastRadius);
    });

    it('keeps separating blast radius well past degree 13', () => {
        // The old `min(8 × degree, 100)` pinned everything from degree 13 upward
        // to 100, so a 13-edge node and a 500-edge node were indistinguishable.
        const thirteen = hub('src/core/a.ts::a', 13, 0).score.blastRadius;
        const forty = hub('src/core/a.ts::a', 40, 0).score.blastRadius;
        expect(thirteen).toBeLessThan(100);
        expect(forty).toBeGreaterThan(thirteen);
    });

    it('does not count a class -> own-method containment edge as an integration', () => {
        // Built through the real graph engine so the assertion is against the
        // edges actually emitted, not a hand-made approximation. A service with
        // three methods used to score as if three things depended on it.
        const g = new BehavioralGraphEngine().buildGraphFromReport(
            repo([file('src/svc/Service.ts', { classes: [cls('Service', ['start', 'stop', 'reload'])] })])
        );
        const classId = 'src/svc/Service.ts::Service';
        const report = engine.assessRisk(differ.computeDiff(graph([]), g), g)
            .find(r => r.nodeId === classId)!;

        expect(report.score.integrationCount).toBe(0);
        expect(report.score.blastRadius).toBe(0);
        expect(report.score.explanation.some(e => /containment edges? excluded/.test(e))).toBe(true);
    });

    it('separates coupling direction from coupling magnitude', () => {
        // Same degree, opposite direction. If fragility were still a transform of
        // degree these two would score identically — which was the defect.
        const inbound = hub('src/core/a.ts::a', 4, 0);
        const outbound = hub('src/core/a.ts::a', 0, 4);
        expect(inbound.score.blastRadius).toBe(outbound.score.blastRadius);
        expect(inbound.score.dependencyFragility).toBeGreaterThan(outbound.score.dependencyFragility);
        expect(inbound.score.overallRisk).toBeGreaterThan(outbound.score.overallRisk);
    });

    it('treats balanced coupling as no inbound-dominance risk at any degree', () => {
        for (const degree of [1, 5, 25]) {
            expect(hub('src/core/a.ts::a', degree, degree).score.dependencyFragility).toBe(0);
        }
    });

    it('flags heuristic coupling in the explanation without hiding it in the score', () => {
        const g = graph(['src/core/a.ts::a', 'b']);
        g.addEdge({ sourceId: 'b', targetId: 'src/core/a.ts::a', type: EdgeType.Invokes, resolution: 'heuristic' });
        const report = engine.assessRisk(differ.computeDiff(graph([]), g), g)
            .find(r => r.nodeId === 'src/core/a.ts::a')!;
        expect(report.score.explanation.some(e => /heuristic name matches/.test(e))).toBe(true);
    });

    it('explains the score with the weights it actually used', () => {
        const report = hub('src/payments/charge.ts::chargeCard', 6, 2);
        const line = report.score.explanation.find(e => e.startsWith('Overall risk'))!;
        const m = line.match(
            /= ([\d.]+) × blast radius \+ ([\d.]+) × inbound dominance \+ ([\d.]+) × runtime criticality/
        );
        expect(m).not.toBeNull();
        const [wBlast, wDominance, wCrit] = m!.slice(1).map(Number);
        const recomputed =
            wBlast * report.score.blastRadius +
            wDominance * report.score.dependencyFragility +
            wCrit * report.score.runtimeCriticality;
        expect(recomputed).toBeCloseTo(report.score.overallRisk, 2);
    });

    it('bottoms out at the criticality floor rather than at zero', () => {
        // Documented so the probe/planning thresholds can be checked against a
        // real number: an isolated, uncritical node is 10.5, not 0.
        const isolated = assess(graph(['src/utils/format.ts::pad']))[0];
        expect(isolated.score.overallRisk).toBe(10.5);
    });
});
