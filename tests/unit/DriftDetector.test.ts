import { describe, it, expect } from 'vitest';
import { DriftDetector } from '../../src/engine/DriftDetector';
import { WorkflowFingerprint } from '../../src/engine/WorkflowFingerprint';
import { VerisState, FingerprintRecord } from '../../src/persistence/VerisState';

const detector = new DriftDetector();

function fp(fingerprint: string, memberCount = 2, workflowId = 'auth'): WorkflowFingerprint {
    return { workflowId, workflowName: workflowId === 'auth' ? 'Authentication' : workflowId, fingerprint, memberCount };
}

/**
 * Minimal VerisState stand-in: only the queries DriftDetector reads.
 * Each value is that workflow's history newest-first, matching fingerprintHistory.
 * Index 0 defaults to the newest timestamp and to run id `run0`, so by default every
 * workflow was last fingerprinted in the same (previous) run.
 */
function fakeState(histories: Record<string, Array<Partial<FingerprintRecord>>>): VerisState {
    const byWorkflow = new Map<string, FingerprintRecord[]>();
    for (const [workflowId, hs] of Object.entries(histories)) {
        byWorkflow.set(workflowId, hs.map((h, i) => ({
            workflowId,
            runId: h.runId ?? 'run' + i,
            fingerprint: h.fingerprint ?? 'x',
            memberCount: h.memberCount ?? 2,
            ts: h.ts ?? '2026-01-0' + (9 - i),
        })));
    }
    return {
        enabled: true,
        fingerprintHistory: (workflowId: string) => byWorkflow.get(workflowId) ?? [],
        knownWorkflowIds: () => [...byWorkflow.keys()],
        latestFingerprintFor: (workflowId: string) => byWorkflow.get(workflowId)?.[0] ?? null,
    } as unknown as VerisState;
}

describe('DriftDetector.detect', () => {
    it('distinguishes a first run from a run with no drift', () => {
        const report = detector.detect('run1', [fp('abc')], null);
        expect(report.firstRun).toBe(true);
        expect(report.workflows[0].driftClass).toBe('first-observation');
        expect(report.workflows[0].changedSinceLastRun).toBe(false);
        expect(report.workflows[0].previousFingerprint).toBeNull();
        // A baseline is not an all-clear — it must not claim drift was looked for.
        expect(report.summary).toMatch(/First run on record/);
        expect(report.summary).not.toMatch(/No workflow drift/);
    });

    it('reports stable when the fingerprint matches the last run', () => {
        const state = fakeState({ auth: [{ fingerprint: 'same' }] });
        const report = detector.detect('run2', [fp('same')], state);
        expect(report.firstRun).toBe(false);
        expect(report.workflows[0].changedSinceLastRun).toBe(false);
        expect(report.workflows[0].driftClass).toBe('stable');
        expect(report.workflows[0].narrative).toMatch(/stable/);
        expect(report.summary).toBe('No workflow drift detected vs prior runs.');
    });

    it('flags a silent rewrite — changed fingerprint, same member count', () => {
        const state = fakeState({ auth: [{ fingerprint: 'old', memberCount: 2 }] });
        const report = detector.detect('run3', [fp('new', 2)], state);
        expect(report.workflows[0].changedSinceLastRun).toBe(true);
        expect(report.workflows[0].driftClass).toBe('silent-rewrite');
        expect(report.workflows[0].memberChange).toBe(0);
        expect(report.workflows[0].narrative).toMatch(/silent rewrite/);
        expect(report.summary).toMatch(/1 silent rewrite/);
    });

    it('reports surface expansion when member count grows', () => {
        const state = fakeState({ auth: [{ fingerprint: 'old', memberCount: 2 }] });
        const report = detector.detect('run4', [fp('new', 5)], state);
        expect(report.workflows[0].driftClass).toBe('surface-expansion');
        expect(report.workflows[0].memberChange).toBe(3);
        expect(report.workflows[0].narrative).toMatch(/expanded/);
    });

    it('reports surface contraction when member count shrinks', () => {
        const state = fakeState({ auth: [{ fingerprint: 'old', memberCount: 5 }] });
        const report = detector.detect('run4b', [fp('new', 2)], state);
        expect(report.workflows[0].driftClass).toBe('surface-contraction');
        expect(report.workflows[0].memberChange).toBe(-3);
        expect(report.workflows[0].narrative).toMatch(/contracted/);
    });

    it('detects oscillation across the last three runs (A,B,A)', () => {
        // history newest-first: [A, B, A] with current = A → flip-flop pattern.
        const state = fakeState({
            auth: [{ fingerprint: 'A' }, { fingerprint: 'B' }, { fingerprint: 'A' }],
        });
        const report = detector.detect('run5', [fp('A')], state);
        expect(report.workflows[0].oscillationDetected).toBe(true);
        expect(report.workflows[0].narrative).toMatch(/Oscillating/);
    });

    it('detects a workflow deleted since the last run (B9)', () => {
        const state = fakeState({
            auth: [{ fingerprint: 'same' }],
            checkout: [{ fingerprint: 'gone', memberCount: 4 }],
        });
        const report = detector.detect('run6', [fp('same')], state);

        const removed = report.workflows.find(w => w.workflowId === 'checkout');
        expect(removed).toBeDefined();
        expect(removed!.driftClass).toBe('removed');
        expect(removed!.changedSinceLastRun).toBe(true);
        expect(removed!.currentFingerprint).toBeNull();
        expect(removed!.previousFingerprint).toBe('gone');
        expect(removed!.memberChange).toBe(-4);
        expect(removed!.memberCountTrend[0]).toBe(0);
        expect(removed!.narrative).toMatch(/REMOVED/);

        expect(report.removedCount).toBe(1);
        expect(report.summary).toMatch(/1 removed/);
        expect(report.summary).not.toMatch(/No workflow drift/);
    });

    it('ranks a removal above a silent rewrite', () => {
        const state = fakeState({
            auth: [{ fingerprint: 'old', memberCount: 2 }],
            checkout: [{ fingerprint: 'gone', memberCount: 4 }],
        });
        const report = detector.detect('run7', [fp('new', 2)], state);
        expect(report.workflows.map(w => w.driftClass)).toEqual(['removed', 'silent-rewrite']);
        expect(report.summary).toMatch(/2 workflows drifted since last run \(1 removed, 1 silent rewrite\)/);
    });

    it('does not re-report a workflow that was already absent from the previous run', () => {
        const state = fakeState({
            auth: [{ fingerprint: 'same', runId: 'recent', ts: '2026-02-01' }],
            checkout: [{ fingerprint: 'gone', runId: 'ancient', ts: '2025-11-01' }],
        });
        const report = detector.detect('run8', [fp('same')], state);
        expect(report.workflows.map(w => w.driftClass)).toEqual(['stable']);
        expect(report.removedCount).toBe(0);
        expect(report.summary).toBe('No workflow drift detected vs prior runs.');
    });

    it('accepts caller-supplied previous workflow ids without a state layer', () => {
        const report = detector.detect('run9', [], null, { previousWorkflowIds: ['ghost'] });
        expect(report.firstRun).toBe(false);
        expect(report.removedCount).toBe(1);
        expect(report.workflows[0].workflowId).toBe('ghost');
        expect(report.workflows[0].driftClass).toBe('removed');
        expect(report.workflows[0].previousFingerprint).toBeNull();
    });

    it('separates a newly observed workflow from drift in tracked ones', () => {
        const state = fakeState({ auth: [{ fingerprint: 'same' }] });
        const report = detector.detect('run10', [fp('same'), fp('x', 3, 'billing')], state);
        expect(report.firstRun).toBe(false);
        const billing = report.workflows.find(w => w.workflowId === 'billing');
        expect(billing!.driftClass).toBe('first-observation');
        expect(report.summary).toMatch(/1 newly observed workflow baselined/);
    });
});
