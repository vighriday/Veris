import { describe, it, expect } from 'vitest';
import { VerificationPlanningEngine } from '../../src/engine/VerificationPlanningEngine';
import { VerificationTier } from '../../src/models/VerificationModels';
import { risk } from './helpers';

const engine = new VerificationPlanningEngine();

// Override the defaulted risk fields the planner branches on.
function riskWith(nodeId: string, over: Partial<{ overallRisk: number; integrationCount: number; blastRadius: number; runtimeCriticality: number }>) {
    const r = risk(nodeId, over.overallRisk ?? 0);
    Object.assign(r.score, over);
    return r;
}

describe('VerificationPlanningEngine.generatePlan', () => {
    it('always emits a Tier 1 structural target per impacted node', () => {
        const p = engine.generatePlan([riskWith('a', {}), riskWith('b', {})]);
        const t1 = p.targets.filter(t => t.tier === VerificationTier.Structural);
        expect(t1.map(t => t.nodeId).sort()).toEqual(['a', 'b']);
    });

    it('adds a Tier 2 behavioral target when integrations or risk are non-trivial', () => {
        const p = engine.generatePlan([riskWith('hub', { integrationCount: 5 })]);
        expect(p.targets.some(t => t.tier === VerificationTier.Behavioral && t.nodeId === 'hub')).toBe(true);
    });

    it('adds a Tier 3 adversarial target for high blast radius or criticality', () => {
        const p = engine.generatePlan([riskWith('crit', { blastRadius: 80, runtimeCriticality: 90 })]);
        const t3 = p.targets.find(t => t.tier === VerificationTier.Adversarial && t.nodeId === 'crit');
        expect(t3).toBeDefined();
        expect(t3!.priority).toBe('High');
    });

    it('keeps a low-risk node at Tier 1 only', () => {
        const p = engine.generatePlan([riskWith('quiet', { overallRisk: 5, integrationCount: 1 })]);
        expect(p.targets).toHaveLength(1);
        expect(p.targets[0].tier).toBe(VerificationTier.Structural);
    });

    it('always includes the CI-delegation recommendation', () => {
        const p = engine.generatePlan([riskWith('a', {})]);
        expect(p.executionRecommendations.some(r => /CI execution pipelines/i.test(r))).toBe(true);
    });
});
