/**
 * Public library surface for `veris-core`.
 *
 * This module only exports. It previously contained a self-executing Phase-1 demo
 * that used the synthetic baseline and was declared as the package `main`, so
 * `require('veris-core')` ran a full repository scan and wrote report files to the
 * consumer's disk as an import side effect.
 *
 * Programmatic use:
 *
 *   import { GitDiffDriver, BehavioralDiffEngine, RiskModelingEngine } from 'veris-core';
 *
 *   const snap = new GitDiffDriver(process.cwd()).snapshot();   // throws BaselineError
 *   const diff = new BehavioralDiffEngine().computeDiff(snap.baseGraph, snap.headGraph);
 *   const risks = new RiskModelingEngine(process.cwd()).assessRisk(diff, snap.headGraph);
 *
 * For the CLI use `npx veris-core`; for the MCP server use `npx veris-core mcp`.
 */

export { RepositoryIntelligenceEngine } from './engine/RepositoryIntelligenceEngine';
export type { RepositoryIntelligenceOptions } from './engine/RepositoryIntelligenceEngine';
export { BehavioralGraphEngine } from './engine/BehavioralGraphEngine';
export { BehavioralDiffEngine } from './engine/BehavioralDiffEngine';
export { RiskModelingEngine } from './engine/RiskModelingEngine';
export { VerificationPlanningEngine } from './engine/VerificationPlanningEngine';
export { ConfidenceEngine } from './engine/ConfidenceEngine';
export type { ConfidenceOptions } from './engine/ConfidenceEngine';
export { GitDiffDriver, BaselineError } from './engine/GitDiffDriver';
export type { GitDiffSnapshots, BaseResolution } from './engine/GitDiffDriver';
export { WorkflowClassifier } from './engine/WorkflowClassifier';
export { WorkflowFingerprintEngine } from './engine/WorkflowFingerprint';
export type { WorkflowFingerprint } from './engine/WorkflowFingerprint';
export { DriftDetector } from './engine/DriftDetector';
export { AdversarialProbeGenerator } from './engine/AdversarialProbeGenerator';
export type { AdversarialProbe } from './engine/AdversarialProbeGenerator';
export { VerificationBudgetAllocator } from './engine/VerificationBudgetAllocator';
export { CounterfactualEngine } from './engine/CounterfactualEngine';
export { OnboardingExporter } from './engine/OnboardingExporter';
export { WatchMode } from './engine/WatchMode';

export { ReportingEngine } from './reporting/ReportingEngine';

export { VerisState, TRUST_CLASSES, EXECUTION_RESULTS } from './persistence/VerisState';
export type {
    TrustClass, ExecutionResult, RunRecord, ExecutionRecord, EvidenceRecord,
    FingerprintRecord, ConfidenceTrendRow, NodeRiskRow, ChainVerification, VerisStateOptions
} from './persistence/VerisState';
export { CrossRepoRegistry } from './persistence/CrossRepoRegistry';

export { loadPlugins } from './plugins/PluginLoader';
export type { PluginApi, PluginPayload, LoadPluginsOptions, ExternalWorkflowRule } from './plugins/PluginLoader';

export { VerisMcpServer } from './mcp/McpServer';
export { TOOL_DEFINITIONS, validateToolArgs, ToolValidationError } from './mcp/ToolSchemas';

export {
    loadWorkflowRules, loadRuntimeRisks, loadProbes, loadRiskConfig
} from './data/DataLoader';
export type { RiskConfig, WorkflowRuleData, ProbeTemplate, ProbeDataFile } from './data/DataLoader';

export * from './models/GraphModels';
export * from './models/EntityModels';
export * from './models/RiskModels';
export * from './models/VerificationModels';
export * from './models/WorkflowModels';
export * from './models/ArchitectureModels';

export { VERIS_VERSION } from './version';
