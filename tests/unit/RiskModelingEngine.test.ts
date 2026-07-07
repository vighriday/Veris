import { describe, it, expect } from 'vitest';
import { RiskModelingEngine } from '../../src/engine/RiskModelingEngine';
import { BehavioralDiffEngine } from '../../src/engine/BehavioralDiffEngine';
import { graph } from './helpers';

// projectRoot defaults to cwd; config resolves from the package data/ dir.
const engine = new RiskModelingEngine();
const differ = new BehavioralDiffEngine();

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
        const hub = 'src/core/hub.ts::hub';
        const nodes = [hub, 'a', 'b', 'c', 'd'];
        const edges = ['a->' + hub, 'b->' + hub, 'c->' + hub, 'd->' + hub];
        const g = graph(nodes, edges);
        const diff = differ.computeDiff(graph([]), g);
        const reports = engine.assessRisk(diff, g);
        const hubReport = reports.find(r => r.nodeId === hub)!;
        const leafReport = reports.find(r => r.nodeId === 'a')!;
        expect(hubReport.score.blastRadius).toBeGreaterThan(leafReport.score.blastRadius);
    });
});
