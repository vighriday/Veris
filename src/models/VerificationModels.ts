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
    overallConfidence: number; // 0 to 100
    executionDepth: number; // Estimated coverage completeness
    unverifiedAssumptions: string[];
    explanation: string[];
}
