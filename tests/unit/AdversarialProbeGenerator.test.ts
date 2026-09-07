import { describe, it, expect } from 'vitest';
import { AdversarialProbeGenerator } from '../../src/engine/AdversarialProbeGenerator';
import { WorkflowKind } from '../../src/models/WorkflowModels';
import { node } from './helpers';
import { risk, domain } from './helpers';

const gen = new AdversarialProbeGenerator();

describe('AdversarialProbeGenerator.generate', () => {
    it('emits probes for a workflow whose anchor clears the risk floor', () => {
        const nodes = [node('pay1'), node('pay2')];
        const workflows = [domain('payments', WorkflowKind.Payments, ['pay1', 'pay2'])];
        const risks = [risk('pay1', 80), risk('pay2', 20)];
        const probes = gen.generate(risks, workflows, nodes);
        expect(probes.length).toBeGreaterThan(0);
        // pay2 is below the floor, so pay1 is the only eligible anchor.
        expect(probes.every(p => p.nodeId === 'pay1')).toBe(true);
        expect(probes.every(p => p.workflowKind === WorkflowKind.Payments)).toBe(true);
    });

    it('skips a workflow whose top risk is below the floor', () => {
        const nodes = [node('n')];
        const workflows = [domain('payments', WorkflowKind.Payments, ['n'])];
        const probes = gen.generate([risk('n', 3)], workflows, nodes, { minRiskThreshold: 10 });
        expect(probes).toHaveLength(0);
    });

    it('caps probes per workflow at maxPerWorkflow', () => {
        const nodes = [node('n')];
        const workflows = [domain('payments', WorkflowKind.Payments, ['n'])];
        const probes = gen.generate([risk('n', 90)], workflows, nodes, { maxPerWorkflow: 1 });
        expect(probes.length).toBeLessThanOrEqual(1);
    });

    it('skips workflows with no in-scope (risk-scored) members', () => {
        const nodes = [node('n')];
        const workflows = [domain('payments', WorkflowKind.Payments, ['n'])];
        // No risk report for 'n' → workflow unaffected → no probes.
        const probes = gen.generate([], workflows, nodes);
        expect(probes).toHaveLength(0);
    });

    it('falls back to generic probes for an unknown workflow kind', () => {
        const nodes = [node('c')];
        const workflows = [domain('core', WorkflowKind.Core, ['c'])];
        const probes = gen.generate([risk('c', 90)], workflows, nodes);
        // Core has no dedicated deck → generic templates apply.
        expect(probes.length).toBeGreaterThan(0);
    });

    it('applies a default risk floor that can actually exclude a workflow', () => {
        // The default was 10 — below the 10.5 the risk formula scores for an
        // isolated, uncritical node — so the filter could never remove anything
        // and the option was decoration.
        const nodes = [node('n')];
        const workflows = [domain('payments', WorkflowKind.Payments, ['n'])];
        expect(gen.generate([risk('n', 20)], workflows, nodes)).toHaveLength(0);
        expect(gen.generate([risk('n', 40)], workflows, nodes).length).toBeGreaterThan(0);
    });

    it('spreads a workflow deck across its riskiest members, highest risk first', () => {
        // Every probe used to point at the single top-risk member, so a workflow
        // of 200 functions was verified as if it were one.
        const ids = ['m0', 'm1', 'm2', 'm3', 'm4'];
        const workflows = [domain('payments', WorkflowKind.Payments, ids)];
        const risks = [risk('m3', 60), risk('m1', 80), risk('m4', 50), risk('m0', 90), risk('m2', 70)];
        const probes = gen.generate(risks, workflows, ids.map(id => node(id)));
        expect(probes).toHaveLength(3);
        expect(probes.map(p => p.nodeId)).toEqual(['m0', 'm1', 'm2']);
    });

    it('anchors only on members that exist in the graph', () => {
        const workflows = [domain('payments', WorkflowKind.Payments, ['ghost', 'real'])];
        const risks = [risk('ghost', 95), risk('real', 60)];
        const probes = gen.generate(risks, workflows, [node('real')]);
        expect(probes.length).toBeGreaterThan(0);
        expect(probes.every(p => p.nodeId === 'real')).toBe(true);
    });

    it('reuses the top anchor when there are fewer eligible members than probes', () => {
        const ids = ['m0', 'm1'];
        const workflows = [domain('payments', WorkflowKind.Payments, ids)];
        const risks = [risk('m0', 90), risk('m1', 70)];
        const probes = gen.generate(risks, workflows, ids.map(id => node(id)));
        expect(probes).toHaveLength(3);
        expect(probes.map(p => p.nodeId)).toEqual(['m0', 'm1', 'm0']);
    });
});
