import { RiskReport } from '../models/RiskModels';
import { VerificationPlan, VerificationTarget, VerificationTier } from '../models/VerificationModels';
import { loadRiskConfig } from '../data/DataLoader';

/**
 * Turns risk scores into tiered verification targets.
 *
 * Every tier boundary is loaded from the `planning` section of
 * data/risk-config.json (override at .veris/data/risk-config.json). They used to
 * be literals in the branch conditions here — the one engine with no config
 * integration, while RiskModelingEngine's header claimed no threshold in the
 * codebase was hardcoded.
 *
 * Thresholds are inclusive minimums, so `tier3MinBlastRadius: 51` is the old
 * `blastRadius > 50` and stays readable next to the value it gates.
 */
export class VerificationPlanningEngine {

    constructor(private projectRoot: string = process.cwd()) {}

    public generatePlan(riskReports: RiskReport[]): VerificationPlan {
        const cfg = loadRiskConfig(this.projectRoot).planning;
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
            if (score.integrationCount >= cfg.tier2MinIntegrationCount || score.overallRisk >= cfg.tier2MinOverallRisk) {
                targets.push({
                    nodeId,
                    tier: VerificationTier.Behavioral,
                    directive: `Validate workflow correctness and integration contracts pointing to/from ${nodeId}`,
                    priority: 'Medium'
                });
                executionRecommendations.add('Run integration tests simulating dependent service data.');
            }

            // Tier 3: High Blast Radius or Runtime Criticality dictates adversarial logic
            if (score.blastRadius >= cfg.tier3MinBlastRadius || score.runtimeCriticality >= cfg.tier3MinRuntimeCriticality) {
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
