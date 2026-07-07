import { describe, it, expect } from 'vitest';
import { BehavioralGraphEngine } from '../../src/engine/BehavioralGraphEngine';
import { EdgeType } from '../../src/models/GraphModels';
import { repo, file, cls, fn } from './helpers';

const engine = new BehavioralGraphEngine();

describe('BehavioralGraphEngine.buildGraphFromReport', () => {
    it('creates nodes for classes, methods, and functions', () => {
        const g = engine.buildGraphFromReport(repo([
            file('src/a.ts', { classes: [cls('Service', ['run'])], functions: [fn('helper')] }),
        ]));
        const ids = g.getNodes().map(n => n.id).sort();
        expect(ids).toContain('src/a.ts::Service');
        expect(ids).toContain('src/a.ts::Service::run');
        expect(ids).toContain('src/a.ts::helper');
    });

    it('links a class to its methods with a DependsOn edge', () => {
        const g = engine.buildGraphFromReport(repo([
            file('src/a.ts', { classes: [cls('Service', ['run'])] }),
        ]));
        const edge = g.getEdges().find(e =>
            e.sourceId === 'src/a.ts::Service' && e.targetId === 'src/a.ts::Service::run');
        expect(edge?.type).toBe(EdgeType.DependsOn);
    });

    it('resolves an Invokes edge across files via the callable index', () => {
        // Caller.go() calls doWork(); doWork is a function in another file.
        const g = engine.buildGraphFromReport(repo([
            file('src/a.ts', { classes: [{ name: 'Caller', methods: [fn('go', ['doWork'])] }] }),
            file('src/b.ts', { functions: [fn('doWork')] }),
        ]));
        const invoke = g.getEdges().find(e => e.type === EdgeType.Invokes
            && e.sourceId === 'src/a.ts::Caller::go' && e.targetId === 'src/b.ts::doWork');
        expect(invoke).toBeDefined();
    });

    it('creates a DependsOn edge for a local relative import', () => {
        const g = engine.buildGraphFromReport(repo([
            file('src/a.ts', { classes: [cls('A')], imports: ['./b'] }),
            file('src/b.ts', { classes: [cls('B')] }),
        ]));
        const edge = g.getEdges().find(e =>
            e.sourceId === 'src/a.ts::A' && e.targetId === 'src/b.ts::B' && e.type === EdgeType.DependsOn);
        expect(edge).toBeDefined();
    });

    it('does not create edges for bare package imports', () => {
        const g = engine.buildGraphFromReport(repo([
            file('src/a.ts', { classes: [cls('A')], imports: ['express', 'lodash'] }),
        ]));
        const crossEdges = g.getEdges().filter(e => e.type === EdgeType.DependsOn
            && !e.targetId.endsWith('::A'));
        // Only the (nonexistent) class→method edges could exist; no import edges.
        expect(crossEdges).toHaveLength(0);
    });
});
