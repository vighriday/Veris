import { RiskReport } from '../models/RiskModels';
import { VerificationPlan, VerificationTarget, VerificationTier } from '../models/VerificationModels';

export class VerificationPlanningEngine {
    
    public generatePlan(riskReports: RiskReport[]): VerificationPlan {
        const targets: VerificationTarget[] = [];
        const executionRecommendations = new Set<string>();

        riskReports.forEach(report => {
            const { score, nodeId } = report;

            // Tier 1: Always do basic structural checks for impacted nodes
            targets.push({
                nodeId,
                tier: VerificationTier.Structural,
                directive: `Run linting, schema validation, and type-checks for ${nodeId}`,
                priority: 'Low'
            });

            // Tier 2: If integration count is noticeable or moderate risk
            if (score.integrationCount > 2 || score.overallRisk > 30) {
                targets.push({
                    nodeId,
                    tier: VerificationTier.Behavioral,
                    directive: `Validate workflow correctness and integration contracts pointing to/from ${nodeId}`,
                    priority: 'Medium'
                });
                executionRecommendations.add('Run integration tests simulating dependent service data.');
            }

            // Tier 3: High Blast Radius or Runtime Criticality dictates adversarial logic
            if (score.blastRadius > 50 || score.runtimeCriticality >= 80) {
                targets.push({
                    nodeId,
                    tier: VerificationTier.Adversarial,
                    directive: `Check concurrency, malformed state handling, and race conditions for ${nodeId}`,
                    priority: 'High'
                });
                executionRecommendations.add('Conduct adversarial testing mapping race conditions against active DB constraints.');
                executionRecommendations.add('Trigger manual QA or specialized Autonomous QA Agent for critical paths.');
            }
        });

        // Default global recommendations
        executionRecommendations.add('Delegate dynamic tests to CI execution pipelines.');

        return {
            targets,
            executionRecommendations: Array.from(executionRecommendations)
        };
    }
}
