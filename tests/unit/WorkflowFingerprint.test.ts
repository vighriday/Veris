import { describe, it, expect } from 'vitest';
import { WorkflowFingerprintEngine } from '../../src/engine/WorkflowFingerprint';
import { WorkflowKind } from '../../src/models/WorkflowModels';
import { graph, domain } from './helpers';

const engine = new WorkflowFingerprintEngine();

describe('WorkflowFingerprintEngine.fingerprint', () => {
    it('is deterministic — same shape yields same hash', () => {
        const g = graph(['a', 'b'], ['a->b']);
        const d = domain('auth', WorkflowKind.Authentication, ['a', 'b']);
        const fp1 = engine.fingerprint(d, g);
        const fp2 = engine.fingerprint(d, graph(['a', 'b'], ['a->b']));
        expect(fp1.fingerprint).toBe(fp2.fingerprint);
        expect(fp1.memberCount).toBe(2);
    });

    it('is order-independent in member ids and edges', () => {
        const d1 = domain('auth', WorkflowKind.Authentication, ['a', 'b', 'c']);
        const d2 = domain('auth', WorkflowKind.Authentication, ['c', 'a', 'b']);
        const g1 = graph(['a', 'b', 'c'], ['a->b', 'b->c']);
        const g2 = graph(['a', 'b', 'c'], ['b->c', 'a->b']);
        expect(engine.fingerprint(d1, g1).fingerprint).toBe(engine.fingerprint(d2, g2).fingerprint);
    });

    it('changes when internal topology changes but members stay (silent rewrite)', () => {
        const d = domain('auth', WorkflowKind.Authentication, ['a', 'b']);
        const before = engine.fingerprint(d, graph(['a', 'b'], ['a->b']));
        const after = engine.fingerprint(d, graph(['a', 'b'], ['b->a']));
        expect(before.fingerprint).not.toBe(after.fingerprint);
        expect(before.memberCount).toBe(after.memberCount);
    });

    it('ignores edges that leave the workflow membership', () => {
        // Edge to an outside node `x` is not internal → must not affect the hash.
        const d = domain('auth', WorkflowKind.Authentication, ['a', 'b']);
        const insideOnly = engine.fingerprint(d, graph(['a', 'b'], ['a->b']));
        const withExternal = engine.fingerprint(d, graph(['a', 'b', 'x'], ['a->b', 'a->x']));
        expect(insideOnly.fingerprint).toBe(withExternal.fingerprint);
    });

    it('differs across workflow kinds even with identical members', () => {
        const g = graph(['a', 'b'], ['a->b']);
        const auth = engine.fingerprint(domain('w', WorkflowKind.Authentication, ['a', 'b']), g);
        const pay = engine.fingerprint(domain('w', WorkflowKind.Payments, ['a', 'b']), g);
        expect(auth.fingerprint).not.toBe(pay.fingerprint);
    });
});
