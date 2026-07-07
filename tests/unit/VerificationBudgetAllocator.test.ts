import { describe, it, expect } from 'vitest';
import { VerificationBudgetAllocator } from '../../src/engine/VerificationBudgetAllocator';
import { VerificationTier } from '../../src/models/VerificationModels';
import { risk, target, plan } from './helpers';

const allocator = new VerificationBudgetAllocator();

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
});
