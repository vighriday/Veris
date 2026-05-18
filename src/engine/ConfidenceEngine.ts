import { RiskReport } from '../models/RiskModels';
import { VerificationPlan, ConfidenceReport } from '../models/VerificationModels';
import { VerisState, ExecutionRecord } from '../persistence/VerisState';
import { loadRiskConfig } from '../data/DataLoader';

/**
 * Confidence engine: math driven entirely by data/risk-config.json -> confidence{}.
 *
 * Inputs:
 *  - riskReports: per-node overallRisk
 *  - plan: verification targets (Tier 1/2/3)
 *  - state (optional): persistent execution history with exponential half-life decay
 *
 * Outputs:
 *  - overallConfidence (0..100)
 *  - executionDepth (0..100) using tier-weighted, time-decayed credit
 *  - explanation (string[])
 *  - unverifiedAssumptions (string[])
 */

export interface ConfidenceOptions {
    halfLifeDays?: number;
    state?: VerisState;
    nodeWorkflowMap?: Record<string, string>;
    projectRoot?: string;
}

export class ConfidenceEngine {

    public calculateConfidence(
        riskReports: RiskReport[],
        plan: VerificationPlan,
        executedTargetsCount: number = 0,
        opts: ConfidenceOptions = {}
    ): ConfidenceReport {
        const cfg = loadRiskConfig(opts.projectRoot ?? process.cwd()).confidence;
        const halfLife = opts.halfLifeDays ?? cfg.halfLifeDays;

        const explanation: string[] = [];
        const unverifiedAssumptions: string[] = [];

        let confidence = 100;

        const totalRisk = riskReports.reduce((acc, r) => acc + r.score.overallRisk, 0);
        const avgRisk = riskReports.length > 0 ? totalRisk / riskReports.length : 0;
        if (avgRisk > 0) {
            confidence -= avgRisk * cfg.riskPenaltyCoefficient;
            explanation.push(`Base confidence degraded to ${confidence.toFixed(1)} due to an average risk score of ${avgRisk.toFixed(1)}.`);
        }

        const executionsByNode = new Map<string, ExecutionRecord[]>();
        if (opts.state && opts.state.enabled) {
            for (const target of plan.targets) {
                const recs = opts.state.executionsForNode(target.nodeId);
                if (recs.length === 0) continue;
                executionsByNode.set(target.nodeId, recs);
            }
        }

        let earned = 0;
        let possible = 0;
        let failedPenalty = 0;
        const now = Date.now();
        for (const target of plan.targets) {
            const tierKey = target.tier.split(' - ')[0];
            const w = cfg.tierWeight[tierKey] ?? 1;
            possible += w;
            const recs = executionsByNode.get(target.nodeId) || [];
            const matching = recs.filter(r => r.tier.startsWith(tierKey));
            if (matching.length === 0) continue;
            matching.sort((a, b) => (b.executedAt || '').localeCompare(a.executedAt || ''));
            const latest = matching[0];
            const ageMs = Math.max(0, now - new Date(latest.executedAt || new Date().toISOString()).getTime());
            const ageDays = ageMs / (1000 * 60 * 60 * 24);
            const decay = Math.pow(0.5, ageDays / halfLife);
            if (latest.result === 'pass') {
                earned += w * decay;
            } else if (latest.result === 'fail') {
                failedPenalty += w * cfg.failurePenaltyPerTierWeight;
                unverifiedAssumptions.push(`Failure on record: ${target.nodeId} (${tierKey}). Most recent run reported result=fail.`);
            } else if (latest.result === 'flaky') {
                earned += w * decay * 0.5;
                failedPenalty += w * cfg.flakyHalfCreditPenalty;
            }
        }

        const stateProvided = (opts.state && opts.state.enabled) || earned > 0;
        let executionDepth: number;
        if (stateProvided) {
            executionDepth = possible > 0 ? (earned / possible) * 100 : 100;
        } else {
            const totalTargets = plan.targets.length;
            executionDepth = totalTargets > 0 ? (executedTargetsCount / totalTargets) * 100 : 100;
        }

        if (executionDepth < 100) {
            confidence -= (100 - executionDepth) * cfg.missingExecutionPenaltyCoefficient;
            const description = stateProvided
                ? `Confidence penalized due to missing or stale execution coverage (decayed depth ${executionDepth.toFixed(1)}%).`
                : `Confidence penalized due to missing execution depth. Only ${executedTargetsCount}/${plan.targets.length} planned verifications completed.`;
            explanation.push(description);
            unverifiedAssumptions.push('Assume behavioral edge cases exist in unexecuted adversarial targets.');
        } else {
            explanation.push('Full execution depth mapped. Confidence remains stable against verification counts.');
        }

        if (failedPenalty > 0) {
            const cappedPenalty = Math.min(cfg.failurePenaltyCap, failedPenalty);
            confidence -= cappedPenalty;
            explanation.push(`Recent verification failures reduced confidence by ${cappedPenalty.toFixed(1)}.`);
        }

        confidence = Math.max(0, Math.min(confidence, 100));

        riskReports.forEach(r => {
            if (r.score.dependencyFragility > cfg.fragilityAssumptionThreshold) {
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
