import { describe, it, expect } from 'vitest';
import { WorkflowClassifier } from '../../src/engine/WorkflowClassifier';
import { BehavioralGraphEngine } from '../../src/engine/BehavioralGraphEngine';
import { BehavioralDiffEngine } from '../../src/engine/BehavioralDiffEngine';
import { RiskModelingEngine } from '../../src/engine/RiskModelingEngine';
import { WorkflowKind } from '../../src/models/WorkflowModels';
import { repo, file, cls, fn } from './helpers';

const graphEngine = new BehavioralGraphEngine();

// A repo with a clear auth directory + a plain util. Uses the real
// data/workflow-rules.json, so assertions stay behavior-level (auth beats
// uncategorized) rather than pinned to exact scores.
function authRepo() {
    return repo([
        file('src/auth/login.ts', { functions: [fn('login'), fn('verifyPassword')] }),
        file('src/utils/format.ts', { functions: [fn('pad')] }),
    ]);
}

describe('WorkflowClassifier.classify', () => {
    it('clusters an auth-path file into the Authentication workflow', () => {
        const r = authRepo();
        const graph = graphEngine.buildGraphFromReport(r);
        const domains = new WorkflowClassifier().classify(r, graph);
        const auth = domains.find(d => d.kind === WorkflowKind.Authentication);
        expect(auth).toBeDefined();
        expect(auth!.memberNodeIds.some(id => id.includes('src/auth/login.ts'))).toBe(true);
        expect(auth!.confidence).toBeGreaterThan(0);
    });

    it('places every graph node into exactly one workflow bucket', () => {
        const r = authRepo();
        const graph = graphEngine.buildGraphFromReport(r);
        const domains = new WorkflowClassifier().classify(r, graph);
        const assigned = domains.reduce((n, d) => n + d.memberNodeIds.length, 0);
        expect(assigned).toBe(graph.getNodes().length);
    });

    it('ingests a plugin rule and clusters by it', () => {
        const c = new WorkflowClassifier();
        c.ingestPluginRules([{ kind: 'Payments', pathTokens: ['ledger'], weight: 5 }]);
        const r = repo([file('src/ledger/post.ts', { functions: [fn('postEntry')] })]);
        const graph = graphEngine.buildGraphFromReport(r);
        const domains = c.classify(r, graph);
        expect(domains.some(d => d.kind === WorkflowKind.Payments)).toBe(true);
    });
});

describe('WorkflowClassifier.aggregate + report', () => {
    it('summarizes an affected workflow with impacted counts', () => {
        const r = authRepo();
        const graph = graphEngine.buildGraphFromReport(r);
        const c = new WorkflowClassifier();
        const domains = c.classify(r, graph);

        // Diff: pretend the whole graph is newly added.
        const diff = new BehavioralDiffEngine().computeDiff(graphEngine.buildGraphFromReport(repo([])), graph);
        const risks = new RiskModelingEngine().assessRisk(diff, graph);
        const aggs = c.aggregate(domains, diff, risks);

        const auth = aggs.find(a => a.kind === WorkflowKind.Authentication);
        expect(auth).toBeDefined();
        expect(auth!.impactedCount).toBeGreaterThan(0);
        expect(auth!.narrative).toMatch(/Authentication workflow/);
    });

    it('report() surfaces unassigned nodes as GraphNode objects', () => {
        // A file with no workflow signal → lands in Uncategorized → unassigned.
        const r = repo([file('src/zzz/thing.ts', { functions: [fn('doThing')] })]);
        const graph = graphEngine.buildGraphFromReport(r);
        const c = new WorkflowClassifier();
        const diff = new BehavioralDiffEngine().computeDiff(graphEngine.buildGraphFromReport(repo([])), graph);
        const risks = new RiskModelingEngine().assessRisk(diff, graph);
        const report = c.report(r, graph, diff, risks);
        expect(Array.isArray(report.unassigned)).toBe(true);
        // Every unassigned entry is a real node with an id + label.
        for (const n of report.unassigned) {
            expect(typeof n.id).toBe('string');
            expect(typeof n.label).toBe('string');
        }
    });
});
