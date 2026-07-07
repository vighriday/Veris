import { describe, it, expect } from 'vitest';
import { DriftDetector } from '../../src/engine/DriftDetector';
import { WorkflowFingerprint } from '../../src/engine/WorkflowFingerprint';
import { VerisState, FingerprintRecord } from '../../src/persistence/VerisState';

const detector = new DriftDetector();

function fp(fingerprint: string, memberCount = 2): WorkflowFingerprint {
    return { workflowId: 'auth', workflowName: 'Authentication', fingerprint, memberCount };
}

// Minimal VerisState stand-in: only the fields DriftDetector reads.
// history must be newest-first, matching VerisState.fingerprintHistory.
function fakeState(history: Array<Partial<FingerprintRecord>>): VerisState {
    const records = history.map((h, i) => ({
        workflowId: 'auth',
        runId: 'run' + i,
        fingerprint: h.fingerprint ?? 'x',
        memberCount: h.memberCount ?? 2,
        ts: h.ts ?? '2026-01-0' + (9 - i),
    }));
    return {
        enabled: true,
        fingerprintHistory: () => records,
    } as unknown as VerisState;
}

describe('DriftDetector.detect', () => {
    it('reports a first observation when there is no state', () => {
        const report = detector.detect('run1', [fp('abc')], null);
        expect(report.workflows[0].changedSinceLastRun).toBe(false);
        expect(report.workflows[0].previousFingerprint).toBeNull();
        expect(report.summary).toMatch(/No workflow drift/);
    });

    it('reports stable when the fingerprint matches the last run', () => {
        const state = fakeState([{ fingerprint: 'same' }]);
        const report = detector.detect('run2', [fp('same')], state);
        expect(report.workflows[0].changedSinceLastRun).toBe(false);
        expect(report.workflows[0].narrative).toMatch(/stable/);
    });

    it('flags a silent rewrite — changed fingerprint, same member count', () => {
        const state = fakeState([{ fingerprint: 'old', memberCount: 2 }]);
        const report = detector.detect('run3', [fp('new', 2)], state);
        expect(report.workflows[0].changedSinceLastRun).toBe(true);
        expect(report.workflows[0].memberChange).toBe(0);
        expect(report.workflows[0].narrative).toMatch(/silent rewrite/);
        expect(report.summary).toMatch(/silent rewrites/);
    });

    it('reports surface expansion when member count grows', () => {
        const state = fakeState([{ fingerprint: 'old', memberCount: 2 }]);
        const report = detector.detect('run4', [fp('new', 5)], state);
        expect(report.workflows[0].memberChange).toBe(3);
        expect(report.workflows[0].narrative).toMatch(/expanded/);
    });

    it('detects oscillation across the last three runs (A,B,A)', () => {
        // history newest-first: [A, B, A] with current = A → flip-flop pattern.
        const state = fakeState([
            { fingerprint: 'A' },
            { fingerprint: 'B' },
            { fingerprint: 'A' },
        ]);
        const report = detector.detect('run5', [fp('A')], state);
        expect(report.workflows[0].oscillationDetected).toBe(true);
    });
});
