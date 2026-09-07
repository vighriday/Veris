import { describe, it, expect } from 'vitest';
import { VerificationBudgetAllocator } from '../../src/engine/VerificationBudgetAllocator';
import { VerificationTier } from '../../src/models/VerificationModels';
import { RiskReport } from '../../src/models/RiskModels';
import { risk, target, plan } from './helpers';

const allocator = new VerificationBudgetAllocator();

/** One risk report per node plus the full T1/T2/T3 target set the planner emits. */
function fullPlan(risks: RiskReport[]) {
    return plan(risks.flatMap(r => [
        target(r.nodeId, VerificationTier.Structural),
        target(r.nodeId, VerificationTier.Behavioral),
        target(r.nodeId, VerificationTier.Adversarial),
    ]));
}

describe('VerificationBudgetAllocator.allocate', () => {
    it('selects nothing when the budget is zero', () => {
        const result = allocator.allocate(
            plan([target('a', VerificationTier.Structural)]),
            [risk('a', 50)],
            [],
            0
        );
        expect(result.selected).toHaveLength(0);
        expect(result.skipped).toHaveLength(1);
        expect(result.skipped[0].reason).toBe('over budget');
    });

    it('prioritizes the higher-risk target when budget fits only one', () => {
        const targets = [
            target('low', VerificationTier.Structural),
            target('high', VerificationTier.Structural),
        ];
        const risks = [risk('low', 10), risk('high', 90)];
        // Budget = 9s: one Tier-1 target (5s) fits, the second (10s total)
        // does not. Greedy leverage sort must pick the high-risk one first.
        const result = allocator.allocate(plan(targets), risks, [], 9 / 60);
        expect(result.selected).toHaveLength(1);
        expect(result.selected[0].nodeId).toBe('high');
    });

    it('never exceeds the budget in estimated seconds', () => {
        const targets = Array.from({ length: 10 }, (_, i) =>
            target('n' + i, VerificationTier.Adversarial)
        );
        const risks = targets.map(t => risk(t.nodeId, 50));
        const budgetMin = 1;
        const result = allocator.allocate(plan(targets), risks, [], budgetMin);
        expect(result.totalEstimatedSec).toBeLessThanOrEqual(budgetMin * 60);
        expect(result.selected.length + result.skipped.length).toBe(targets.length);
    });

    it('reports tier coverage counts that match the selection', () => {
        const targets = [
            target('a', VerificationTier.Structural),
            target('b', VerificationTier.Behavioral),
            target('c', VerificationTier.Adversarial),
        ];
        const risks = targets.map(t => risk(t.nodeId, 60));
        const result = allocator.allocate(plan(targets), risks, [], 60);
        const total = result.coverage.tier1 + result.coverage.tier2 + result.coverage.tier3;
        expect(total).toBe(result.selected.length);
    });

    it('gives the three tiers the same leverage per second for one node', () => {
        // The calibration invariant. Any tierLeverage that is not proportional to
        // tierCostSeconds reintroduces a silent per-tier constant in the ranking —
        // at 1/3/7 against 5/30/120 it was 1 : 0.5 : 0.29 against deeper work.
        const result = allocator.allocate(fullPlan([risk('x', 50)]), [risk('x', 50)], [], 60);
        expect(result.selected).toHaveLength(3);
        expect(new Set(result.selected.map(s => s.score)).size).toBe(1);
    });

    it('reaches an adversarial target before spending the budget on cheap structural ones', () => {
        // 100 moderate-risk structural checks against one high-risk adversarial
        // target. Under the old calibration every Tier 1 outranked the Tier 3 and
        // the adversarial target was never reached.
        const risks = [
            risk('critical', 90),
            ...Array.from({ length: 100 }, (_, i) => risk('n' + String(i).padStart(3, '0'), 40)),
        ];
        const targets = [
            target('critical', VerificationTier.Adversarial),
            ...risks.slice(1).map(r => target(r.nodeId, VerificationTier.Structural)),
        ];
        const result = allocator.allocate(plan(targets), risks, [], 125 / 60);
        expect(result.selected[0].nodeId).toBe('critical');
        expect(result.coverage.tier3).toBe(1);
    });

    it('pins the tier mix over a 40-node plan at a fixed budget', () => {
        // Regression pin for the density calibration. With tierLeverage 1/3/7 this
        // was T1=30 T2=15 T3=0 at ten minutes: the deepest tier, and the only one
        // that finds the failures this product exists to surface, got nothing.
        const risks = Array.from({ length: 40 }, (_, i) =>
            risk('n' + String(i).padStart(2, '0'), 90 - i * 2));
        const result = allocator.allocate(fullPlan(risks), risks, [], 10);

        expect(result.coverage).toEqual({ tier1: 12, tier2: 6, tier3: 3 });
        expect(result.totalEstimatedSec).toBe(600);
        // Budget is spent depth-first on the riskiest nodes, not breadth-first on
        // the cheapest checks.
        expect(result.selected.slice(0, 3).map(s => s.tier)).toEqual([
            VerificationTier.Structural, VerificationTier.Behavioral, VerificationTier.Adversarial,
        ]);
        expect(result.selected.slice(0, 3).every(s => s.nodeId === 'n00')).toBe(true);
    });

    it('orders deterministically when two targets carry the same leverage', () => {
        const risks = [risk('b', 50), risk('a', 50)];
        const first = allocator.allocate(fullPlan(risks), risks, [], 60);
        const second = allocator.allocate(fullPlan([...risks].reverse()), risks, [], 60);
        expect(first.selected.map(s => s.nodeId + s.tier))
            .toEqual(second.selected.map(s => s.nodeId + s.tier));
        expect(first.selected[0].nodeId).toBe('a');
    });
});
