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
        // Anchor = highest-risk member.
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
});
