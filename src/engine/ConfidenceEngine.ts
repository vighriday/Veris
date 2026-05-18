import { RiskReport } from '../models/RiskModels';
import { VerificationPlan, ConfidenceReport } from '../models/VerificationModels';
import { VerisState, ExecutionRecord } from '../persistence/VerisState';

/**
 * Confidence calculation with:
 *  - Real execution history (from VerisState) instead of caller-supplied integers.
 *  - Half-life decay: a verification from 30 days ago counts less than one from yesterday.
 *  - Tier weighting: Tier 3 executions buy more confidence than Tier 1.
 *  - Failed executions actively reduce confidence.
 *  - Backwards-compatible with the old signature (state optional).
 */
const DEFAULT_HALF_LIFE_DAYS = 14;

const TIER_WEIGHT: Record<string, number> = {
    'Tier 1': 1,
    'Tier 2': 2,
    'Tier 3': 4
};

export interface ConfidenceOptions {
    halfLifeDays?: number;
    state?: VerisState;
    nodeWorkflowMap?: Record<string, string>;
}

export class ConfidenceEngine {

    public calculateConfidence(
        riskReports: RiskReport[],
        plan: VerificationPlan,
        executedTargetsCount: number = 0,
        opts: ConfidenceOptions = {}
    ): ConfidenceReport {
        const explanation: string[] = [];
        const unverifiedAssumptions: string[] = [];

        let confidence = 100;
        const halfLife = opts.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS;

        const totalRisk = riskReports.reduce((acc, r) => acc + r.score.overallRisk, 0);
        const avgRisk = riskReports.length > 0 ? totalRisk / riskReports.length : 0;
        if (avgRisk > 0) {
            confidence -= avgRisk * 0.4;
            explanation.push(`Base confidence degraded to ${confidence.toFixed(1)} due to an average risk score of ${avgRisk.toFixed(1)}.`);
        }

        // Real execution history if state available
        const executionsByNode = new Map<string, ExecutionRecord[]>();
        if (opts.state && opts.state.enabled) {
            const now = Date.now();
            for (const target of plan.targets) {
                const recs = opts.state.executionsForNode(target.nodeId);
                if (recs.length === 0) continue;
                executionsByNode.set(target.nodeId, recs);
            }
        }

        // Compute effective execution depth using decayed weights
        let earned = 0;
        let possible = 0;
        let failedPenalty = 0;
        const now = Date.now();
        for (const target of plan.targets) {
            const tierKey = target.tier.split(' - ')[0];
            const w = TIER_WEIGHT[tierKey] ?? 1;
            possible += w;
            const recs = executionsByNode.get(target.nodeId) || [];
            const matching = recs.filter(r => r.tier.startsWith(tierKey));
            if (matching.length === 0) continue;
            // Pick the freshest execution for this target+tier
            matching.sort((a, b) => (b.executedAt || '').localeCompare(a.executedAt || ''));
            const latest = matching[0];
            const ageMs = Math.max(0, now - new Date(latest.executedAt || new Date().toISOString()).getTime());
            const ageDays = ageMs / (1000 * 60 * 60 * 24);
            const decay = Math.pow(0.5, ageDays / halfLife);
            if (latest.result === 'pass') {
                earned += w * decay;
            } else if (latest.result === 'fail') {
                failedPenalty += w * 6;
                unverifiedAssumptions.push(`Failure on record: ${target.nodeId} (${tierKey}). Most recent run reported result=fail.`);
            } else if (latest.result === 'flaky') {
                earned += w * decay * 0.5;
                failedPenalty += w * 2;
            }
            // 'skipped' contributes nothing
        }

        // If caller passed a manual count and no state-derived earned, fall back to old behavior
        const stateProvided = (opts.state && opts.state.enabled) || earned > 0;
        let executionDepth: number;
        if (stateProvided) {
            executionDepth = possible > 0 ? (earned / possible) * 100 : 100;
        } else {
            const totalTargets = plan.targets.length;
            executionDepth = totalTargets > 0 ? (executedTargetsCount / totalTargets) * 100 : 100;
        }

        if (executionDepth < 100) {
            confidence -= (100 - executionDepth) * 0.5;
            const description = stateProvided
                ? `Confidence penalized due to missing or stale execution coverage (decayed depth ${executionDepth.toFixed(1)}%).`
                : `Confidence penalized due to missing execution depth. Only ${executedTargetsCount}/${plan.targets.length} planned verifications completed.`;
            explanation.push(description);
            unverifiedAssumptions.push('Assume behavioral edge cases exist in unexecuted adversarial targets.');
        } else {
            explanation.push('Full execution depth mapped. Confidence remains stable against verification counts.');
        }

        if (failedPenalty > 0) {
            confidence -= Math.min(40, failedPenalty);
            explanation.push(`Recent verification failures reduced confidence by ${Math.min(40, failedPenalty).toFixed(1)}.`);
        }

        confidence = Math.max(0, Math.min(confidence, 100));

        riskReports.forEach(r => {
            if (r.score.dependencyFragility > 60) {
                unverifiedAssumptions.push(`Highly coupled node ${r.nodeId} may have hidden integration drift not covered by standard planning.`);
            }
        });

        return {
            overallConfidence: parseFloat(confidence.toFixed(2)),
            executionDepth: parseFloat(executionDepth.toFixed(2)),
            unverifiedAssumptions,
            explanation
        };
    }
}
