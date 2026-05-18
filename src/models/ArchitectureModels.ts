import { BVIFile, RepositoryIntelligenceReport } from "./EntityModels";

export interface LanguageAdapter {
    name: string;
    analyze(projectRoot: string): RepositoryIntelligenceReport;
}

export interface SecurityBaselineConfig {
    zeroRetentionMode: boolean;
    airGapped: boolean;
    ignoredPaths: string[];
}
