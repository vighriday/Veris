/**
 * Public JSON Schemas for Veris MCP tool outputs.
 *
 * Consumers (CI scripts, downstream tooling, agents) use these to validate
 * shape contract. Each export is a JSON Schema draft 2020-12 fragment.
 *
 * Bumped when MCP tool response shape changes. Treat as a stable interface.
 */

export const SCHEMA_VERSION = "1.0.0";

export const RiskScoreSchema = {
    $id: "veris://risk-score",
    type: "object",
    required: ["blastRadius", "runtimeCriticality", "integrationCount", "dependencyFragility", "overallRisk", "explanation"],
    properties: {
        blastRadius: { type: "number", minimum: 0, maximum: 100 },
        runtimeCriticality: { type: "number", minimum: 0, maximum: 100 },
        integrationCount: { type: "integer", minimum: 0 },
        dependencyFragility: { type: "number", minimum: 0, maximum: 100 },
        overallRisk: { type: "number", minimum: 0, maximum: 100 },
        explanation: { type: "array", items: { type: "string" } }
    }
};

export const WorkflowAggregateSchema = {
    $id: "veris://workflow-aggregate",
    type: "object",
    required: ["workflowId", "workflowName", "kind", "memberCount", "impactedCount", "averageRisk", "maxRisk", "narrative"],
    properties: {
        workflowId: { type: "string" },
        workflowName: { type: "string" },
        kind: { type: "string" },
        memberCount: { type: "integer", minimum: 0 },
        impactedCount: { type: "integer", minimum: 0 },
        addedCount: { type: "integer", minimum: 0 },
        removedCount: { type: "integer", minimum: 0 },
        averageRisk: { type: "number", minimum: 0, maximum: 100 },
        maxRisk: { type: "number", minimum: 0, maximum: 100 },
        narrative: { type: "string" },
        runtimeRisks: { type: "array", items: { type: "string" } }
    }
};

export const ConfidenceReportSchema = {
    $id: "veris://confidence-report",
    type: "object",
    required: ["overallConfidence", "executionDepth", "explanation", "unverifiedAssumptions"],
    properties: {
        overallConfidence: { type: "number", minimum: 0, maximum: 100 },
        executionDepth: { type: "number", minimum: 0, maximum: 100 },
        explanation: { type: "array", items: { type: "string" } },
        unverifiedAssumptions: { type: "array", items: { type: "string" } }
    }
};

export const AdversarialProbeSchema = {
    $id: "veris://adversarial-probe",
    type: "object",
    required: ["nodeId", "category", "scenario", "expectedInvariant", "severity"],
    properties: {
        nodeId: { type: "string" },
        workflowId: { type: "string" },
        workflowKind: { type: "string" },
        category: { type: "string", enum: ["concurrency", "idempotency", "malformed-state", "retry-storm", "partial-failure", "ordering", "auth-edge", "expiry", "cache-stampede", "replay"] },
        scenario: { type: "string" },
        expectedInvariant: { type: "string" },
        severity: { type: "string", enum: ["low", "medium", "high"] }
    }
};

export const DriftReportSchema = {
    $id: "veris://drift-report",
    type: "object",
    required: ["runId", "workflows", "summary"],
    properties: {
        runId: { type: "string" },
        summary: { type: "string" },
        workflows: {
            type: "array",
            items: {
                type: "object",
                required: ["workflowId", "currentFingerprint", "changedSinceLastRun", "narrative"],
                properties: {
                    workflowId: { type: "string" },
                    workflowName: { type: "string" },
                    currentFingerprint: { type: "string" },
                    previousFingerprint: { type: ["string", "null"] },
                    changedSinceLastRun: { type: "boolean" },
                    distinctFingerprintsObserved: { type: "integer", minimum: 1 },
                    memberCountTrend: { type: "array", items: { type: "integer" } },
                    oscillationDetected: { type: "boolean" },
                    memberChange: { type: "integer" },
                    narrative: { type: "string" }
                }
            }
        }
    }
};

export const ALL_SCHEMAS = {
    version: SCHEMA_VERSION,
    schemas: {
        RiskScore: RiskScoreSchema,
        WorkflowAggregate: WorkflowAggregateSchema,
        ConfidenceReport: ConfidenceReportSchema,
        AdversarialProbe: AdversarialProbeSchema,
        DriftReport: DriftReportSchema
    }
};
