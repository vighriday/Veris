import { describe, it, expect } from 'vitest';
import { BehavioralDiffEngine } from '../../src/engine/BehavioralDiffEngine';
import { graph } from './helpers';

const engine = new BehavioralDiffEngine();

describe('BehavioralDiffEngine.computeDiff', () => {
    it('reports no changes for identical graphs', () => {
        const g = graph(['a', 'b'], ['a->b']);
        const diff = engine.computeDiff(g, graph(['a', 'b'], ['a->b']));
        expect(diff.addedNodes).toHaveLength(0);
        expect(diff.removedNodes).toHaveLength(0);
        expect(diff.addedEdges).toHaveLength(0);
        expect(diff.removedEdges).toHaveLength(0);
        expect(diff.impactedNodes).toHaveLength(0);
    });

    it('detects an added node and marks it impacted even with no edges', () => {
        const oldG = graph(['a']);
        const newG = graph(['a', 'b']);
        const diff = engine.computeDiff(oldG, newG);
        expect(diff.addedNodes.map(n => n.id)).toEqual(['b']);
        // An isolated new node still ships behavior — it must be impacted.
        expect(diff.impactedNodes.map(n => n.id)).toContain('b');
    });

    it('detects a removed node', () => {
        const diff = engine.computeDiff(graph(['a', 'b']), graph(['a']));
        expect(diff.removedNodes.map(n => n.id)).toEqual(['b']);
    });

    it('marks both endpoints of an added edge as impacted', () => {
        const oldG = graph(['a', 'b']);
        const newG = graph(['a', 'b'], ['a->b']);
        const diff = engine.computeDiff(oldG, newG);
        expect(diff.addedEdges).toHaveLength(1);
        const impacted = diff.impactedNodes.map(n => n.id).sort();
        expect(impacted).toEqual(['a', 'b']);
    });

    it('does not resurrect removed (tombstone) nodes into impactedNodes', () => {
        // Edge a->b removed by dropping node b. b is gone from the new graph,
        // so only surviving endpoint `a` may be impacted, never `b`.
        const oldG = graph(['a', 'b'], ['a->b']);
        const newG = graph(['a']);
        const diff = engine.computeDiff(oldG, newG);
        expect(diff.removedEdges).toHaveLength(1);
        const impactedIds = diff.impactedNodes.map(n => n.id);
        expect(impactedIds).toContain('a');
        expect(impactedIds).not.toContain('b');
    });
});
