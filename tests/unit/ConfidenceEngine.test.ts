import { describe, it, expect } from 'vitest';
import { ConfidenceEngine } from '../../src/engine/ConfidenceEngine';
import { VerificationTier } from '../../src/models/VerificationModels';
import { risk, target, plan } from './helpers';

const engine = new ConfidenceEngine();

describe('ConfidenceEngine.calculateConfidence', () => {
    it('is full confidence with no risk and no plan', () => {
        const report = engine.calculateConfidence([], plan([]), 0);
        expect(report.overallConfidence).toBe(100);
        expect(report.executionDepth).toBe(100);
    });

    it('degrades confidence as average risk rises', () => {
        const low = engine.calculateConfidence([risk('n', 10)], plan([]), 0);
        const high = engine.calculateConfidence([risk('n', 90)], plan([]), 0);
        expect(high.overallConfidence).toBeLessThan(low.overallConfidence);
    });

    it('penalizes missing execution depth', () => {
        const targets = [
            target('a', VerificationTier.Structural),
            target('b', VerificationTier.Behavioral),
        ];
        // 0 of 2 executed → depth 0, confidence penalized, assumption surfaced.
        const none = engine.calculateConfidence([], plan(targets), 0);
        const all = engine.calculateConfidence([], plan(targets), 2);
        expect(none.executionDepth).toBe(0);
        expect(all.executionDepth).toBe(100);
        expect(none.overallConfidence).toBeLessThan(all.overallConfidence);
        expect(none.unverifiedAssumptions.length).toBeGreaterThan(0);
    });

    it('clamps confidence to the 0..100 range under extreme risk', () => {
        const report = engine.calculateConfidence(
            Array.from({ length: 50 }, (_, i) => risk('n' + i, 100)),
            plan([target('x', VerificationTier.Adversarial)]),
            0
        );
        expect(report.overallConfidence).toBeGreaterThanOrEqual(0);
        expect(report.overallConfidence).toBeLessThanOrEqual(100);
    });

    it('flags highly-coupled nodes as an unverified assumption', () => {
        // fragility above the config threshold (default 60) → coupling warning.
        const report = engine.calculateConfidence([risk('hub', 20, 95)], plan([]), 0);
        expect(report.unverifiedAssumptions.some(a => a.includes('hub'))).toBe(true);
    });
});
