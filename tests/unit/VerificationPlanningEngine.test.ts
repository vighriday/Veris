import { describe, it, expect, afterAll } from 'vitest';
import { VerificationPlanningEngine } from '../../src/engine/VerificationPlanningEngine';
import { VerificationTier } from '../../src/models/VerificationModels';
import { risk } from './helpers';
import { tmpDir, writeFile, cleanupAll } from './tmpRepo';

const engine = new VerificationPlanningEngine();

afterAll(cleanupAll);

// Override the defaulted risk fields the planner branches on.
function riskWith(nodeId: string, over: Partial<{ overallRisk: number; integrationCount: number; blastRadius: number; runtimeCriticality: number }>) {
    const r = risk(nodeId, over.overallRisk ?? 0);
    Object.assign(r.score, over);
    return r;
}

/** A project root whose .veris override replaces some planning thresholds. */
function rootWithPlanning(planning: Record<string, number>): string {
    const root = tmpDir('veris-planning-');
    writeFile(root, '.veris/data/risk-config.json', JSON.stringify({ planning }));
    return root;
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

    it('treats every threshold as an inclusive minimum', () => {
        // Shipped tier3MinBlastRadius is 51, so 51 promotes and 50 does not. The
        // boundary is a config value, not a `> 50` buried in the branch.
        const at = engine.generatePlan([riskWith('at', { blastRadius: 51 })]);
        const below = engine.generatePlan([riskWith('below', { blastRadius: 50 })]);
        expect(at.targets.some(t => t.tier === VerificationTier.Adversarial)).toBe(true);
        expect(below.targets.some(t => t.tier === VerificationTier.Adversarial)).toBe(false);
    });

    it('reads its tier boundaries from config rather than from literals in the branches', () => {
        // Raising the Tier 2 gates out of reach must silence Tier 2 for a node that
        // clears the shipped ones; lowering the Tier 3 gate must promote a node
        // that the shipped ones leave alone. Both fail if a threshold is hardcoded.
        const strict = new VerificationPlanningEngine(
            rootWithPlanning({ tier2MinIntegrationCount: 999, tier2MinOverallRisk: 999 })
        );
        const busy = riskWith('busy', { integrationCount: 5, overallRisk: 60 });
        expect(engine.generatePlan([busy]).targets.some(t => t.tier === VerificationTier.Behavioral)).toBe(true);
        expect(strict.generatePlan([busy]).targets.some(t => t.tier === VerificationTier.Behavioral)).toBe(false);

        const lenient = new VerificationPlanningEngine(rootWithPlanning({ tier3MinBlastRadius: 10 }));
        const mild = riskWith('mild', { blastRadius: 20 });
        expect(engine.generatePlan([mild]).targets.some(t => t.tier === VerificationTier.Adversarial)).toBe(false);
        expect(lenient.generatePlan([mild]).targets.some(t => t.tier === VerificationTier.Adversarial)).toBe(true);
    });
});
