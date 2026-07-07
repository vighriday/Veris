import { describe, it, expect } from 'vitest';
import { CounterfactualEngine } from '../../src/engine/CounterfactualEngine';
import { graph } from './helpers';

const engine = new CounterfactualEngine();

describe('CounterfactualEngine.whatIfRevert', () => {
    it('drops impacted-node count when a change is hypothetically reverted', () => {
        // base has only `a`; head adds a payment node. Reverting it removes the impact.
        const base = graph(['a']);
        const head = graph(['a', 'src/payments/charge.ts::charge'], ['a->src/payments/charge.ts::charge']);
        const result = engine.whatIfRevert(base, head, ['src/payments/charge.ts::charge']);
        expect(result.actualImpacted).toBeGreaterThan(result.counterfactualImpacted);
        expect(result.impactedDelta).toBeGreaterThan(0);
    });

    it('reduces average risk when a high-risk node is reverted', () => {
        const base = graph([]);
        const head = graph(['src/payments/charge.ts::charge']);
        const result = engine.whatIfRevert(base, head, ['src/payments/charge.ts::charge']);
        expect(result.actualHeadRisk).toBeGreaterThan(0);
        expect(result.counterfactualRisk).toBe(0);
        expect(result.delta).toBeGreaterThan(0);
        expect(result.narrative).toMatch(/drop average risk|does not measurably/);
    });

    it('reports no measurable change when reverting an unrelated node', () => {
        const base = graph(['a']);
        const head = graph(['a', 'b'], ['a->b']);
        // Removing a node id not present in head → counterfactual == actual.
        const result = engine.whatIfRevert(base, head, ['does-not-exist']);
        expect(result.delta).toBe(0);
        expect(result.impactedDelta).toBe(0);
    });

    it('echoes the removed node ids back', () => {
        const result = engine.whatIfRevert(graph([]), graph(['x', 'y']), ['x', 'y']);
        expect(result.removedNodeIds.sort()).toEqual(['x', 'y']);
    });
});
