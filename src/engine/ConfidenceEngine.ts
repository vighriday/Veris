import { RiskReport } from '../models/RiskModels';
import { VerificationPlan } from '../models/VerificationModels';
import { ConfidenceReport } from '../models/VerificationModels';

export class ConfidenceEngine {

    public calculateConfidence(riskReports: RiskReport[], plan: VerificationPlan, executedTargetsCount: number = 0): ConfidenceReport {
        const explanation: string[] = [];
        const unverifiedAssumptions: string[] = [];

        // Base confidence starts high
        let confidence = 100;
        
        // Sum up total risk
        const totalRisk = riskReports.reduce((acc, curr) => acc + curr.score.overallRisk, 0);
        const avgRisk = riskReports.length > 0 ? totalRisk / riskReports.length : 0;

        if (avgRisk > 0) {
            confidence -= (avgRisk * 0.4); // Risk lowers max potential confidence
            explanation.push(`Base confidence degraded to ${confidence.toFixed(1)} due to an average risk score of ${avgRisk.toFixed(1)}.`);
        }

        // Measure coverage execution (simulated)
        const totalTargets = plan.targets.length;
        const executionDepth = totalTargets > 0 ? (executedTargetsCount / totalTargets) * 100 : 100;

        if (executionDepth < 100) {
            confidence -= (100 - executionDepth) * 0.5; // Lack of testing creates uncertainty
            explanation.push(`Confidence penalized due to missing execution depth. Only ${executedTargetsCount}/${totalTargets} planned verifications completed.`);
            unverifiedAssumptions.push('Assume behavioral edge cases exist in unexecuted adversarial targets.');
        } else {
            explanation.push(`Full execution depth mapped. Confidence remains relatively stable against verification counts.`);
        }

        // Cap constraints
        confidence = Math.max(0, Math.min(confidence, 100));

        // Unverified assumption heuristics
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
