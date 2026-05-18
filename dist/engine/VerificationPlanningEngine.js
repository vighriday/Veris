"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.VerificationPlanningEngine = void 0;
const VerificationModels_1 = require("../models/VerificationModels");
class VerificationPlanningEngine {
    generatePlan(riskReports) {
        const targets = [];
        const executionRecommendations = new Set();
        riskReports.forEach(report => {
            const { score, nodeId } = report;
            // Tier 1: Always do basic structural checks for impacted nodes
            targets.push({
                nodeId,
                tier: VerificationModels_1.VerificationTier.Structural,
                directive: `Run linting, schema validation, and type-checks for ${nodeId}`,
                priority: 'Low'
            });
            // Tier 2: If integration count is noticeable or moderate risk
            if (score.integrationCount > 2 || score.overallRisk > 30) {
                targets.push({
                    nodeId,
                    tier: VerificationModels_1.VerificationTier.Behavioral,
                    directive: `Validate workflow correctness and integration contracts pointing to/from ${nodeId}`,
                    priority: 'Medium'
                });
                executionRecommendations.add('Run integration tests simulating dependent service data.');
            }
            // Tier 3: High Blast Radius or Runtime Criticality dictates adversarial logic
            if (score.blastRadius > 50 || score.runtimeCriticality >= 80) {
                targets.push({
                    nodeId,
                    tier: VerificationModels_1.VerificationTier.Adversarial,
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
exports.VerificationPlanningEngine = VerificationPlanningEngine;
