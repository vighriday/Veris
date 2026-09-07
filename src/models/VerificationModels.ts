export enum VerificationTier {
    Structural = 'Tier 1 - Structural Verification',
    Behavioral = 'Tier 2 - Behavioral Verification',
    Adversarial = 'Tier 3 - Adversarial Verification'
}

export interface VerificationTarget {
    nodeId: string;
    tier: VerificationTier;
    directive: string;
    priority: 'High' | 'Medium' | 'Low';
}

export interface VerificationPlan {
    targets: VerificationTarget[];
    executionRecommendations: string[];
}

export interface ConfidenceReport {
    /**
     * @deprecated Alias of `executionDepth`, kept so existing consumers keep working.
     * It is evidence coverage, not a probability that the code is correct — the
     * previous composite score was never calibrated against outcomes. Prefer the
     * named fields below.
     */
    overallConfidence: number;
    /** Tier-weighted, time-decayed, trust-weighted evidence coverage, 0-100. */
    executionDepth: number;
    /** False when nothing was planned: coverage is unknown, not complete. */
    coverageKnown: boolean;
    plannedTargets: number;
    failingTargets: number;
    flakyTargets: number;
    /** Highest single impacted-node risk. Risk does not average, so this is the max. */
    maxImpactedRisk: number;
    highRiskNodeCount: number;
    unverifiedAssumptions: string[];
    explanation: string[];
}
