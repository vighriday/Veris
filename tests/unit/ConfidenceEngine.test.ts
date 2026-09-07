import { describe, it, expect } from 'vitest';
import { ConfidenceEngine } from '../../src/engine/ConfidenceEngine';
import { VerificationTier } from '../../src/models/VerificationModels';
import { risk, target, plan } from './helpers';
import type { VerisState, EvidenceRecord, TrustClass, ExecutionResult } from '../../src/persistence/VerisState';

const engine = new ConfidenceEngine();

const DAY = 86_400_000;
const NOW = Date.parse('2026-01-15T00:00:00.000Z');

/**
 * Minimal VerisState stand-in. The engine only reads `enabled` and
 * `executionsForNode`, so a fake keeps these tests free of sqlite and of the
 * filesystem while still exercising the real evidence-weighting paths.
 */
function fakeState(rows: Partial<EvidenceRecord>[]): VerisState {
    const full = rows.map((r, i) => ({
        seq: i + 1,
        runId: 'run1',
        nodeId: 'a',
        workflowId: null,
        tier: 'Tier 1 - Structural Verification',
        directive: 'check',
        result: 'pass' as ExecutionResult,
        detail: null,
        durationMs: null,
        executedAt: new Date(NOW).toISOString(),
        producer: 'test',
        trustClass: 'harness-observed' as TrustClass,
        prevHash: '',
        rowHash: '',
        ...r,
    })) as EvidenceRecord[];

    return {
        enabled: true,
        executionsForNode: (nodeId: string) => full.filter(r => r.nodeId === nodeId),
    } as unknown as VerisState;
}

describe('ConfidenceEngine — what the number means', () => {
    // Finding C6: "nothing planned" is not "everything verified". Reporting 100%
    // here read as a clean bill of health for a repository nobody had looked at.
    it('reports coverage as unknown when nothing was planned', () => {
        const report = engine.calculateConfidence([], plan([]), 0, { now: NOW });
        expect(report.coverageKnown).toBe(false);
        expect(report.explanation.join(' ')).toMatch(/unknown rather than complete/i);
    });

    // Finding C2: the score no longer encodes risk. It measures evidence coverage,
    // and risk is reported separately as its own named field.
    it('separates risk from coverage instead of folding risk into one score', () => {
        const targets = [target('a', VerificationTier.Structural)];
        const low = engine.calculateConfidence([risk('a', 10)], plan(targets), 0, { now: NOW });
        const high = engine.calculateConfidence([risk('a', 90)], plan(targets), 0, { now: NOW });

        expect(low.executionDepth).toBe(high.executionDepth);
        expect(high.maxImpactedRisk).toBeGreaterThan(low.maxImpactedRisk);
        expect(high.maxImpactedRisk).toBe(90);
    });

    // Finding C3: risk was summarized with a mean, so adding harmless files diluted a
    // dangerous one and improved the reported position.
    it('summarizes risk by maximum, so harmless nodes cannot dilute a dangerous one', () => {
        const alone = engine.calculateConfidence([risk('danger', 90)], plan([]), 0, { now: NOW });
        const padded = engine.calculateConfidence(
            [risk('danger', 90), ...Array.from({ length: 10 }, (_, i) => risk('trivial' + i, 1))],
            plan([]), 0, { now: NOW }
        );
        expect(padded.maxImpactedRisk).toBe(alone.maxImpactedRisk);
        expect(padded.highRiskNodeCount).toBe(1);
    });

    it('keeps overallConfidence as an alias of executionDepth for compatibility', () => {
        const targets = [target('a', VerificationTier.Structural)];
        const report = engine.calculateConfidence([], plan(targets), 0, { now: NOW });
        expect(report.overallConfidence).toBe(report.executionDepth);
    });
});

describe('ConfidenceEngine — evidence weighting', () => {
    it('credits coverage for a recent passing result', () => {
        const targets = [target('a', VerificationTier.Structural)];
        const report = engine.calculateConfidence([], plan(targets), 0, {
            now: NOW,
            state: fakeState([{ nodeId: 'a', result: 'pass' }]),
        });
        expect(report.executionDepth).toBe(100);
    });

    // Finding C4: passes decayed with a half-life while failures applied at full
    // strength forever. Decay must be symmetric or the two are not comparable.
    it('decays a passing result as it ages', () => {
        const targets = [target('a', VerificationTier.Structural)];
        const fresh = engine.calculateConfidence([], plan(targets), 0, {
            now: NOW, halfLifeDays: 14,
            state: fakeState([{ nodeId: 'a', result: 'pass', executedAt: new Date(NOW).toISOString() }]),
        });
        const stale = engine.calculateConfidence([], plan(targets), 0, {
            now: NOW, halfLifeDays: 14,
            state: fakeState([{ nodeId: 'a', result: 'pass', executedAt: new Date(NOW - 14 * DAY).toISOString() }]),
        });
        expect(fresh.executionDepth).toBe(100);
        expect(stale.executionDepth).toBeCloseTo(50, 0);
    });

    // Finding C5: flaky earned half credit AND took a penalty in the same branch, so
    // the two partly cancelled by an amount driven by unrelated config values.
    it('gives a flaky result no coverage credit and counts it once', () => {
        const targets = [target('a', VerificationTier.Structural)];
        const report = engine.calculateConfidence([], plan(targets), 0, {
            now: NOW,
            state: fakeState([{ nodeId: 'a', result: 'flaky' }]),
        });
        expect(report.executionDepth).toBe(0);
        expect(report.flakyTargets).toBe(1);
    });

    it('counts a failing target and surfaces it as an assumption', () => {
        const targets = [target('a', VerificationTier.Structural)];
        const report = engine.calculateConfidence([], plan(targets), 0, {
            now: NOW,
            state: fakeState([{ nodeId: 'a', result: 'fail' }]),
        });
        expect(report.failingTargets).toBe(1);
        expect(report.executionDepth).toBe(0);
        expect(report.unverifiedAssumptions.some(a => a.includes('Recorded failure'))).toBe(true);
    });

    // Finding D2: the agent under evaluation supplies its own evidence, so its own
    // assertion cannot be worth as much as an independent observation.
    it('weights agent-asserted evidence below harness-observed evidence', () => {
        const targets = [target('a', VerificationTier.Structural)];
        const observed = engine.calculateConfidence([], plan(targets), 0, {
            now: NOW,
            state: fakeState([{ nodeId: 'a', result: 'pass', trustClass: 'harness-observed' }]),
        });
        const asserted = engine.calculateConfidence([], plan(targets), 0, {
            now: NOW,
            state: fakeState([{ nodeId: 'a', result: 'pass', trustClass: 'agent-asserted' }]),
        });
        expect(observed.executionDepth).toBe(100);
        expect(asserted.executionDepth).toBe(50);
        expect(asserted.explanation.join(' ')).toMatch(/agent-asserted/);
    });

    // The evidence log is append-only, so a later self-asserted pass sits alongside
    // an earlier independently-observed failure rather than replacing it. The
    // more-trusted failure must win.
    it('does not let a later agent-asserted pass bury a harness-observed failure', () => {
        const targets = [target('a', VerificationTier.Structural)];
        const report = engine.calculateConfidence([], plan(targets), 0, {
            now: NOW,
            state: fakeState([
                { nodeId: 'a', result: 'pass', trustClass: 'agent-asserted', executedAt: new Date(NOW).toISOString() },
                { nodeId: 'a', result: 'fail', trustClass: 'harness-observed', executedAt: new Date(NOW - DAY).toISOString() },
            ]),
        });
        expect(report.failingTargets).toBe(1);
        expect(report.executionDepth).toBe(0);
    });
});

describe('ConfidenceEngine — reporting hygiene', () => {
    // Finding C7: the branch compared the unrounded float, so full coverage printed
    // "penalized due to missing coverage (decayed depth 100.0%)".
    it('does not claim missing coverage when coverage is complete', () => {
        const targets = [target('a', VerificationTier.Structural)];
        const report = engine.calculateConfidence([], plan(targets), 0, {
            now: NOW,
            state: fakeState([{ nodeId: 'a', result: 'pass' }]),
        });
        expect(report.executionDepth).toBe(100);
        expect(report.explanation.join(' ')).not.toMatch(/missing|penal/i);
    });

    // Finding C8: documented on the MCP tool, hardcoded to 0 on the CLI path, and
    // unreachable on the MCP path. A documented parameter that does nothing.
    it('honours executedTargetsCount as a what-if override when no state exists', () => {
        const targets = [
            target('a', VerificationTier.Structural),
            target('b', VerificationTier.Behavioral),
        ];
        const none = engine.calculateConfidence([], plan(targets), 0, { now: NOW });
        const half = engine.calculateConfidence([], plan(targets), 1, { now: NOW });
        const all = engine.calculateConfidence([], plan(targets), 2, { now: NOW });
        expect(none.executionDepth).toBe(0);
        expect(half.executionDepth).toBe(50);
        expect(all.executionDepth).toBe(100);
    });

    // Finding F2: this loop emitted one string per qualifying node, uncapped and
    // undeduplicated — 5,947 copies of the same sentence, 98% of the markdown report.
    it('caps unverified assumptions and reports the remainder as a count', () => {
        const many = Array.from({ length: 500 }, (_, i) => risk('hub' + i, 20, 95));
        const report = engine.calculateConfidence(many, plan([]), 0, { now: NOW });

        expect(report.unverifiedAssumptions.length).toBeLessThanOrEqual(21);
        expect(report.unverifiedAssumptions.some(a => /further densely coupled/.test(a))).toBe(true);
    });

    it('still names the most densely coupled nodes it does list', () => {
        const report = engine.calculateConfidence([risk('hub', 20, 95)], plan([]), 0, { now: NOW });
        expect(report.unverifiedAssumptions.some(a => a.includes('hub'))).toBe(true);
    });

    it('keeps coverage within 0..100 under extreme input', () => {
        const report = engine.calculateConfidence(
            Array.from({ length: 50 }, (_, i) => risk('n' + i, 100)),
            plan([target('x', VerificationTier.Adversarial)]),
            0,
            { now: NOW }
        );
        expect(report.executionDepth).toBeGreaterThanOrEqual(0);
        expect(report.executionDepth).toBeLessThanOrEqual(100);
    });
});
