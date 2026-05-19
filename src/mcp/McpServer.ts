import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { RepositoryIntelligenceEngine } from '../engine/RepositoryIntelligenceEngine';
import { BehavioralGraphEngine } from '../engine/BehavioralGraphEngine';
import { BehavioralDiffEngine } from '../engine/BehavioralDiffEngine';
import { RiskModelingEngine } from '../engine/RiskModelingEngine';
import { VerificationPlanningEngine } from '../engine/VerificationPlanningEngine';
import { ConfidenceEngine } from '../engine/ConfidenceEngine';
import { GitDiffDriver } from '../engine/GitDiffDriver';
import { WorkflowClassifier } from '../engine/WorkflowClassifier';
import { WorkflowFingerprintEngine } from '../engine/WorkflowFingerprint';
import { DriftDetector } from '../engine/DriftDetector';
import { AdversarialProbeGenerator } from '../engine/AdversarialProbeGenerator';
import { VerificationBudgetAllocator } from '../engine/VerificationBudgetAllocator';
import { CounterfactualEngine } from '../engine/CounterfactualEngine';
import { OnboardingExporter } from '../engine/OnboardingExporter';
import { BehavioralGraph } from '../models/GraphModels';
import { WorkflowReport } from '../models/WorkflowModels';
import { VerisState } from '../persistence/VerisState';
import { CrossRepoRegistry } from '../persistence/CrossRepoRegistry';
import { loadPlugins } from '../plugins/PluginLoader';
import { RepositoryIntelligenceReport } from '../models/EntityModels';
import * as path from 'path';

export class VerisMcpServer {
    private server: Server;
    private projectRoot: string;
    private state: VerisState;

    // Session cache
    private lastReport: RepositoryIntelligenceReport | null = null;
    private currentGraph: BehavioralGraph | null = null;
    private baseGraph: BehavioralGraph | null = null;
    private lastDiffReport: any = null;
    private lastRiskReports: any[] = [];
    private lastPlan: any = null;
    private lastWorkflowReport: WorkflowReport | null = null;
    private lastFingerprints: any[] = [];
    private lastRunId: string | null = null;
    private pluginsLoaded: string[] = [];

    constructor() {
        this.server = new Server(
            { name: "veris-mcp-server", version: "1.2.0" },
            { capabilities: { tools: {} } }
        );
        this.projectRoot = path.resolve(process.cwd());
        this.state = new VerisState(this.projectRoot);
        this.setupToolHandlers();
        this.server.onerror = (error) => console.error('[MCP Error]', error);
    }

    private setupToolHandlers() {
        this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: this.toolDefinitions()
        }));

        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const args = (request.params.arguments || {}) as any;
            switch (request.params.name) {
                case "analyze_repository": return this.handleAnalyzeRepository();
                case "export_behavioral_graph": return this.handleExportGraph();
                case "analyze_pr_behavior": return this.handleAnalyzePr(args);
                case "generate_verification_plan": return this.handleGeneratePlan();
                case "identify_unverified_behaviors": return this.handleIdentifyUnverified(args);
                case "list_workflows": return this.handleListWorkflows();
                case "analyze_workflow": return this.handleAnalyzeWorkflow(args);
                case "detect_drift": return this.handleDetectDrift();
                case "generate_adversarial_probes": return this.handleGenerateProbes();
                case "allocate_budget": return this.handleAllocateBudget(args);
                case "what_if_revert": return this.handleWhatIfRevert(args);
                case "report_execution": return this.handleReportExecution(args);
                case "confidence_history": return this.handleConfidenceHistory(args);
                case "node_history": return this.handleNodeHistory(args);
                case "export_onboarding": return this.handleExportOnboarding();
                case "cross_repo_snapshot": return this.handleCrossRepoSnapshot();
                case "register_repo": return this.handleRegisterRepo(args);
                default: throw new Error(`Unknown tool: ${request.params.name}`);
            }
        });
    }

    private toolDefinitions() {
        return [
            { name: "analyze_repository",
              description: "Analyzes the repository AST and returns file/entity counts. First step in the chain.",
              inputSchema: { type: "object", properties: {}, required: [] } },
            { name: "export_behavioral_graph",
              description: "Exports the full behavioral graph of the current repository as JSON: nodes (every class, method, top-level function detected by ts-morph) and edges (DependsOn from imports plus real Invokes from call-expression resolution). Each node is colored by its semantic workflow domain (Authentication, Payments, Webhooks, Caching, Queue, and 20 more). Use this when you need machine-readable graph data for downstream analysis or visualization. Returns nodeCount, edgeCount, and the full nodes/edges arrays.",
              inputSchema: { type: "object", properties: {}, required: [] } },
            { name: "analyze_pr_behavior",
              description: "Computes real git-worktree diff vs base ref (defaults: origin/main, main, HEAD~1), returns impacted workflows and risk scores. Synthetic 70% slice fallback when no git base available.",
              inputSchema: { type: "object", properties: { baseRef: { type: "string" } }, required: [] } },
            { name: "generate_verification_plan",
              description: "Generates a tiered verification plan for every node impacted by the current PR or graph state. Returns concrete directives at three tiers: Tier 1 (structural — syntax, schema, type, lint checks), Tier 2 (behavioral — workflow correctness, contracts, integration boundaries), and Tier 3 (adversarial — concurrency, idempotency, retry storms, replay, cache stampede, partial failure). Each directive is keyed to a specific nodeId so an agent can prioritize execution. Use this to answer 'what should I verify before merging this PR?'.",
              inputSchema: { type: "object", properties: {}, required: [] } },
            { name: "identify_unverified_behaviors",
              description: "Returns confidence score using real execution history (decayed by half-life) + remaining unverified assumptions. Pass executedTargetsCount to override state-derived value.",
              inputSchema: { type: "object", properties: { executedTargetsCount: { type: "number" } }, required: [] } },
            { name: "list_workflows",
              description: "Auto-clusters the graph into semantic workflow domains (Authentication, Billing, Checkout, Caching, Queue, etc.) and returns per-workflow narrative impact + max/avg risk + runtime risk hypotheses. This is the workflow-first view of the repo.",
              inputSchema: { type: "object", properties: {}, required: [] } },
            { name: "analyze_workflow",
              description: "Deep-dive on a single workflow: members, inference signals, top risks, runtime risk hypotheses.",
              inputSchema: { type: "object", properties: { workflowId: { type: "string" } }, required: ["workflowId"] } },
            { name: "detect_drift",
              description: "Compares current workflow fingerprints against prior runs in state.db. Surfaces silent rewrites (same members, different topology), surface expansion/contraction, and oscillating refactors.",
              inputSchema: { type: "object", properties: {}, required: [] } },
            { name: "generate_adversarial_probes",
              description: "Generates concrete Tier 3 adversarial test hypotheses per high-risk node (concurrency, idempotency, retry storms, replay, partial failure, cache stampede, ordering). Each probe has a scenario + expected invariant.",
              inputSchema: { type: "object", properties: {}, required: [] } },
            { name: "allocate_budget",
              description: "Given a budget in minutes, greedy-allocates the highest-leverage subset of verification targets. Leverage = (tier × workflow criticality × risk) / estimated cost.",
              inputSchema: { type: "object", properties: { minutes: { type: "number" } }, required: ["minutes"] } },
            { name: "what_if_revert",
              description: "Counterfactual: simulates removing the named nodes from the head graph, then recomputes diff + risk vs the actual base. Answers 'what behaviors recover if I revert this?'.",
              inputSchema: { type: "object", properties: { nodeIds: { type: "array", items: { type: "string" } } }, required: ["nodeIds"] } },
            { name: "report_execution",
              description: "Closes the feedback loop. External agents (any MCP-compatible coding agent, CI runner) post back verification results — pass/fail/flaky/skipped per nodeId+tier+directive. Confidence math now uses real data instead of a counter.",
              inputSchema: {
                  type: "object",
                  properties: {
                      executions: {
                          type: "array",
                          items: {
                              type: "object",
                              properties: {
                                  nodeId: { type: "string" },
                                  workflowId: { type: "string" },
                                  tier: { type: "string" },
                                  directive: { type: "string" },
                                  result: { type: "string", enum: ["pass", "fail", "skipped", "flaky"] },
                                  detail: { type: "string" },
                                  durationMs: { type: "number" }
                              },
                              required: ["nodeId", "tier", "result"]
                          }
                      }
                  },
                  required: ["executions"]
              } },
            { name: "confidence_history",
              description: "Returns the confidence-score and execution-depth trend across the last N Veris runs persisted in local state (.veris/state.db). Confidence math uses a 14-day half-life decay over real execution results — so this surface shows whether the project's verification confidence is improving, decaying, or oscillating over time. Useful for dashboards, weekly health checks, or detecting regressions in test coverage discipline. Defaults to last 20 runs; pass `limit` to widen.",
              inputSchema: { type: "object", properties: { limit: { type: "number", description: "Maximum number of runs to return. Defaults to 20." } }, required: [] } },
            { name: "node_history",
              description: "Returns execution + risk history for a specific node across all recorded runs.",
              inputSchema: { type: "object", properties: { nodeId: { type: "string" } }, required: ["nodeId"] } },
            { name: "export_onboarding",
              description: "Writes a workflow-first onboarding map to veris-reports/onboarding/ — one markdown file per workflow, plus an index.",
              inputSchema: { type: "object", properties: {}, required: [] } },
            { name: "cross_repo_snapshot",
              description: "Returns the latest confidence + drift snapshot across all repos registered in ~/.veris/registry.json. Useful when a workflow spans services.",
              inputSchema: { type: "object", properties: {}, required: [] } },
            { name: "register_repo",
              description: "Adds a repo to the user-level cross-repo registry. Subsequent cross_repo_snapshot calls will include it.",
              inputSchema: { type: "object", properties: { name: { type: "string" }, path: { type: "string" }, tags: { type: "array", items: { type: "string" } } }, required: ["name", "path"] } }
        ];
    }

    // --- handlers ---

    private text(payload: any) {
        return { content: [{ type: "text", text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2) }] };
    }

    private ensureReport(): RepositoryIntelligenceReport {
        if (this.lastReport) return this.lastReport;
        const engine = new RepositoryIntelligenceEngine(this.projectRoot);
        this.lastReport = engine.analyze();
        return this.lastReport;
    }
    private ensureGraph(): BehavioralGraph {
        if (this.currentGraph) return this.currentGraph;
        this.ensureReport();
        const ge = new BehavioralGraphEngine();
        this.currentGraph = ge.buildGraphFromReport(this.lastReport!);
        return this.currentGraph;
    }
    private ensureDiffAndRisk(): { diff: any; risks: any[] } {
        if (this.lastDiffReport && this.lastRiskReports.length > 0) {
            return { diff: this.lastDiffReport, risks: this.lastRiskReports };
        }
        const head = this.ensureGraph();
        const driver = new GitDiffDriver(this.projectRoot);
        const snap = driver.snapshot();
        let base: BehavioralGraph;
        if (snap) {
            base = snap.baseGraph;
        } else {
            base = new BehavioralGraph();
            head.getNodes().slice(0, Math.floor(head.getNodes().length * 0.7)).forEach(n => base.addNode(n));
            head.getEdges().slice(0, Math.floor(head.getEdges().length * 0.7)).forEach(e => base.addEdge(e));
        }
        this.baseGraph = base;
        const diff = new BehavioralDiffEngine().computeDiff(base, head);
        const risks = new RiskModelingEngine(this.projectRoot).assessRisk(diff, head);
        this.lastDiffReport = diff;
        this.lastRiskReports = risks;
        return { diff, risks };
    }
    private ensureWorkflows(): WorkflowReport {
        if (this.lastWorkflowReport) return this.lastWorkflowReport;
        const report = this.ensureReport();
        const graph = this.ensureGraph();
        const { diff, risks } = this.ensureDiffAndRisk();
        const classifier = new WorkflowClassifier(this.projectRoot);
        const plugins = loadPlugins(this.projectRoot);
        this.pluginsLoaded = plugins.loadedPlugins;
        classifier.ingestPluginRules(plugins.extraWorkflowRules);
        classifier.ingestExtraRuntimeRisks(plugins.extraRuntimeRisks);
        this.lastWorkflowReport = classifier.report(report, graph, diff, risks);
        return this.lastWorkflowReport;
    }
    private ensurePlan(): any {
        if (this.lastPlan) return this.lastPlan;
        const { risks } = this.ensureDiffAndRisk();
        this.lastPlan = new VerificationPlanningEngine().generatePlan(risks);
        return this.lastPlan;
    }

    private handleAnalyzeRepository() {
        const r = this.ensureReport();
        return this.text(`Repository analyzed. Found ${r.files.length} files.`);
    }
    private handleExportGraph() {
        const g = this.ensureGraph();
        return this.text({
            nodesCount: g.getNodes().length,
            edgesCount: g.getEdges().length,
            sampleNodes: g.getNodes().slice(0, 5)
        });
    }
    private handleAnalyzePr(args: any) {
        const driver = new GitDiffDriver(this.projectRoot);
        const snap = driver.snapshot(args.baseRef);
        const head = this.ensureGraph();
        let mode = 'synthetic'; let refs: any = {};
        if (snap) {
            this.baseGraph = snap.baseGraph;
            mode = 'git';
            refs = { baseRef: snap.baseRef, headRef: snap.headRef };
        } else if (!this.baseGraph) {
            const b = new BehavioralGraph();
            head.getNodes().slice(0, Math.floor(head.getNodes().length * 0.7)).forEach(n => b.addNode(n));
            head.getEdges().slice(0, Math.floor(head.getEdges().length * 0.7)).forEach(e => b.addEdge(e));
            this.baseGraph = b;
        }
        const diff = new BehavioralDiffEngine().computeDiff(this.baseGraph!, head);
        const risks = new RiskModelingEngine(this.projectRoot).assessRisk(diff, head);
        this.lastDiffReport = diff; this.lastRiskReports = risks;
        this.lastWorkflowReport = null;
        return this.text({
            diffMode: mode, ...refs,
            addedNodes: diff.addedNodes.length,
            removedNodes: diff.removedNodes.length,
            impactedNodes: diff.impactedNodes.length,
            riskReports: risks.slice(0, 3)
        });
    }
    private handleGeneratePlan() {
        const plan = this.ensurePlan();
        return this.text(plan);
    }
    private handleIdentifyUnverified(args: any) {
        const { risks } = this.ensureDiffAndRisk();
        const plan = this.ensurePlan();
        const confidence = new ConfidenceEngine().calculateConfidence(risks, plan, args.executedTargetsCount || 0, { state: this.state, projectRoot: this.projectRoot });
        return this.text(confidence);
    }
    private handleListWorkflows() {
        const wf = this.ensureWorkflows();
        const summary = wf.aggregates.map(a => ({
            workflowId: a.workflowId, workflowName: a.workflowName,
            memberCount: a.memberCount, impactedCount: a.impactedCount, addedCount: a.addedCount,
            averageRisk: a.averageRisk, maxRisk: a.maxRisk,
            narrative: a.narrative, runtimeRisks: a.runtimeRisks
        }));
        return this.text({ workflowCount: wf.workflows.length, workflows: summary, pluginsLoaded: this.pluginsLoaded });
    }
    private handleAnalyzeWorkflow(args: any) {
        const { workflowId } = args;
        if (!workflowId) throw new Error("workflowId is required");
        const wf = this.ensureWorkflows();
        const d = wf.workflows.find(w => w.id === workflowId);
        const a = wf.aggregates.find(x => x.workflowId === workflowId);
        if (!d || !a) throw new Error(`Workflow '${workflowId}' not found. Available: ${wf.workflows.map(w => w.id).join(', ')}`);
        return this.text({
            workflow: { id: d.id, name: d.name, kind: d.kind, memberCount: d.memberNodeIds.length, confidence: d.confidence, signals: d.signals, members: d.memberNodeIds },
            impact: a
        });
    }
    private handleDetectDrift() {
        const wf = this.ensureWorkflows();
        const graph = this.ensureGraph();
        const fps = new WorkflowFingerprintEngine().fingerprintAll(wf.workflows, graph);
        this.lastFingerprints = fps;
        if (!this.lastRunId) this.lastRunId = this.state.newRunId();
        const drift = new DriftDetector().detect(this.lastRunId, fps, this.state);
        return this.text(drift);
    }
    private handleGenerateProbes() {
        const wf = this.ensureWorkflows();
        const { risks } = this.ensureDiffAndRisk();
        const probes = new AdversarialProbeGenerator(this.projectRoot).generate(risks, wf.workflows, this.ensureGraph().getNodes());
        return this.text({ probeCount: probes.length, probes });
    }
    private handleAllocateBudget(args: any) {
        const minutes = Number(args.minutes);
        if (!minutes || minutes <= 0) throw new Error("minutes must be a positive number");
        const plan = this.ensurePlan();
        const wf = this.ensureWorkflows();
        const { risks } = this.ensureDiffAndRisk();
        const allocation = new VerificationBudgetAllocator(this.projectRoot).allocate(plan, risks, wf.workflows, minutes);
        return this.text(allocation);
    }
    private handleWhatIfRevert(args: any) {
        if (!Array.isArray(args.nodeIds) || args.nodeIds.length === 0) throw new Error("nodeIds (non-empty array) required");
        const head = this.ensureGraph();
        const driver = new GitDiffDriver(this.projectRoot);
        const snap = driver.snapshot();
        let base = this.baseGraph;
        if (!base && snap) base = snap.baseGraph;
        if (!base) {
            base = new BehavioralGraph();
            head.getNodes().slice(0, Math.floor(head.getNodes().length * 0.7)).forEach(n => base!.addNode(n));
            head.getEdges().slice(0, Math.floor(head.getEdges().length * 0.7)).forEach(e => base!.addEdge(e));
        }
        const result = new CounterfactualEngine(this.projectRoot).whatIfRevert(base, head, args.nodeIds);
        return this.text(result);
    }
    private handleReportExecution(args: any) {
        const executions = args.executions || [];
        if (!this.lastRunId) this.lastRunId = this.state.newRunId();
        const now = new Date().toISOString();
        for (const e of executions) {
            this.state.recordExecution({
                runId: this.lastRunId,
                nodeId: e.nodeId,
                workflowId: e.workflowId ?? null,
                tier: e.tier,
                directive: e.directive ?? '',
                result: e.result,
                detail: e.detail,
                durationMs: e.durationMs,
                executedAt: now
            });
        }
        return this.text({ recorded: executions.length, runId: this.lastRunId });
    }
    private handleConfidenceHistory(args: any) {
        return this.text(this.state.confidenceTrend(args.limit || 30));
    }
    private handleNodeHistory(args: any) {
        if (!args.nodeId) throw new Error("nodeId is required");
        return this.text(this.state.executionsForNode(args.nodeId));
    }
    private handleExportOnboarding() {
        const wf = this.ensureWorkflows();
        const result = new OnboardingExporter().export(this.projectRoot, wf, this.ensureGraph());
        return this.text(result);
    }
    private handleCrossRepoSnapshot() {
        const reg = new CrossRepoRegistry();
        return this.text(reg.snapshot());
    }
    private handleRegisterRepo(args: any) {
        const reg = new CrossRepoRegistry();
        const entry = reg.register(args.name, args.path, args.tags);
        return this.text(entry);
    }

    async run() {
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        console.error("Veris MCP Server running on stdio");
    }
}
