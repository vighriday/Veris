import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { BehavioralDiffEngine } from '../engine/BehavioralDiffEngine';
import { RiskModelingEngine } from '../engine/RiskModelingEngine';
import { VerificationPlanningEngine } from '../engine/VerificationPlanningEngine';
import { ConfidenceEngine } from '../engine/ConfidenceEngine';
import { GitDiffDriver, BaselineError, GitDiffSnapshots } from '../engine/GitDiffDriver';
import { WorkflowClassifier } from '../engine/WorkflowClassifier';
import { WorkflowFingerprintEngine } from '../engine/WorkflowFingerprint';
import { DriftDetector } from '../engine/DriftDetector';
import { AdversarialProbeGenerator } from '../engine/AdversarialProbeGenerator';
import { VerificationBudgetAllocator } from '../engine/VerificationBudgetAllocator';
import { CounterfactualEngine } from '../engine/CounterfactualEngine';
import { OnboardingExporter } from '../engine/OnboardingExporter';
import { BehavioralGraph } from '../models/GraphModels';
import { WorkflowReport } from '../models/WorkflowModels';
import { VerisState, EXECUTION_RESULTS, TRUST_CLASSES, TrustClass, ExecutionRecord } from '../persistence/VerisState';
import { CrossRepoRegistry } from '../persistence/CrossRepoRegistry';
import { loadPlugins } from '../plugins/PluginLoader';
import { RepositoryIntelligenceReport } from '../models/EntityModels';
import { VERIS_VERSION } from '../version';
import { TOOL_DEFINITIONS, validateToolArgs, ToolValidationError } from './ToolSchemas';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Veris over the Model Context Protocol.
 *
 * Two properties this layer must hold, both of which it previously violated:
 *
 * 1. RESPONSES ARE BOUNDED. Every payload lands in an agent's context window.
 *    The unbounded plan response measured 12.28 MB and `allocate_budget` returned
 *    the *complement* of its selection, reaching 16.3 MB — enough to exhaust the
 *    window before any of it could be read. Every list response here is capped and
 *    reports `truncated: { shown, total }` when it elides anything.
 *
 * 2. THE CACHE EXPIRES. The core use case is "the agent edits code, then asks what
 *    changed". Caching the parse for the process lifetime made every answer after
 *    the first edit stale by construction, with no indication. The cache is now
 *    keyed on the newest source mtime.
 */

/** Caps on list-shaped responses. Callers get a count and a pointer, not a dump. */
const CAPS = {
    graphNodes: 500,
    graphEdges: 1000,
    planTargets: 200,
    probes: 100,
    workflows: 50,
    budgetSelected: 200,
    riskReports: 25,
    history: 100,
    files: 100
};

function cap<T>(items: T[], limit: number): { items: T[]; truncated?: { shown: number; total: number } } {
    if (items.length <= limit) return { items };
    return { items: items.slice(0, limit), truncated: { shown: limit, total: items.length } };
}

export class VerisMcpServer {
    private server: Server;
    private projectRoot: string;
    private state: VerisState;

    // Session cache, invalidated when source changes on disk.
    private cacheStamp: number | null = null;
    private lastReport: RepositoryIntelligenceReport | null = null;
    private currentGraph: BehavioralGraph | null = null;
    private baseGraph: BehavioralGraph | null = null;
    private lastSnapshot: GitDiffSnapshots | null = null;
    private lastDiffReport: any = null;
    private lastRiskReports: any[] = [];
    private lastPlan: any = null;
    private lastWorkflowReport: WorkflowReport | null = null;
    private lastFingerprints: any[] = [];
    private lastRunId: string | null = null;
    private runPersisted = false;
    private pluginsLoaded: string[] = [];
    private pluginWarnings: string[] = [];

    constructor(projectRoot?: string) {
        this.server = new Server(
            { name: "veris-mcp-server", version: VERIS_VERSION },
            { capabilities: { tools: {} } }
        );
        this.projectRoot = path.resolve(projectRoot ?? process.cwd());
        this.state = new VerisState(this.projectRoot);
        this.setupToolHandlers();
        this.server.onerror = (error) => console.error('[MCP Error]', error);
    }

    private setupToolHandlers() {
        this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: TOOL_DEFINITIONS
        }));

        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const name = request.params.name;
            try {
                // The low-level Server does not enforce the schemas advertised in
                // tools/list, so `required` and enum constraints were decoration and
                // malformed arguments reached handlers directly.
                const args = validateToolArgs(name, request.params.arguments ?? {});

                switch (name) {
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
                    default: return this.error(`Unknown tool: ${name}`);
                }
            } catch (e) {
                if (e instanceof ToolValidationError) {
                    return this.error(`Invalid arguments for ${name}: ${e.message}`);
                }
                if (e instanceof BaselineError) {
                    // Stated plainly so the agent can act, rather than being handed a
                    // fabricated diff it cannot distinguish from a real one.
                    return this.error(
                        `Cannot establish a baseline: ${e.reason}. Veris does not fabricate one. ` +
                        `Run inside a git repository with history, or pass an explicit baseRef ` +
                        `(e.g. "HEAD~1"). In shallow CI checkouts, fetch full history first.`
                    );
                }
                return this.error((e as Error).message);
            }
        });
    }

    // --- response helpers ---

    private text(payload: any) {
        return { content: [{ type: "text", text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2) }] };
    }

    private error(message: string) {
        return { isError: true, content: [{ type: "text", text: message }] };
    }

    // --- cache ---

    /**
     * Newest mtime across analyzable source. Cheap enough to run per call and it is
     * the only thing standing between an agent's edit and a stale answer.
     */
    private sourceStamp(): number {
        let newest = 0;
        const skip = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', 'veris-reports', '.veris']);
        const walk = (dir: string, depth: number) => {
            if (depth > 12) return;
            let entries: fs.Dirent[];
            try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
            } catch {
                return;
            }
            for (const e of entries) {
                if (e.name.startsWith('.') && e.name !== '.veris') continue;
                if (skip.has(e.name)) continue;
                const full = path.join(dir, e.name);
                if (e.isDirectory()) {
                    walk(full, depth + 1);
                } else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(e.name)) {
                    try {
                        const m = fs.statSync(full).mtimeMs;
                        if (m > newest) newest = m;
                    } catch {
                        // unreadable file cannot invalidate anything
                    }
                }
            }
        };
        walk(this.projectRoot, 0);
        return newest;
    }

    private checkCache(): void {
        const stamp = this.sourceStamp();
        if (this.cacheStamp !== null && stamp !== this.cacheStamp) {
            this.invalidateAll();
        }
        this.cacheStamp = stamp;
    }

    /** Every derived cache resets together, so none can be stale relative to another. */
    private invalidateDerived(): void {
        this.lastDiffReport = null;
        this.lastRiskReports = [];
        this.lastPlan = null;
        this.lastWorkflowReport = null;
        this.lastFingerprints = [];
    }

    private invalidateAll(): void {
        this.lastReport = null;
        this.currentGraph = null;
        this.baseGraph = null;
        this.lastSnapshot = null;
        this.runPersisted = false;
        this.invalidateDerived();
    }

    // --- pipeline ---

    private ensureSnapshot(baseRef?: string): GitDiffSnapshots {
        this.checkCache();
        if (this.lastSnapshot && !baseRef) return this.lastSnapshot;
        const driver = new GitDiffDriver(this.projectRoot);
        const snap = driver.snapshot(baseRef);
        if (baseRef) this.invalidateAll();
        this.lastSnapshot = snap;
        this.lastReport = snap.headReport;
        this.currentGraph = snap.headGraph;
        this.baseGraph = snap.baseGraph;
        this.cacheStamp = this.sourceStamp();
        return snap;
    }

    private ensureReport(): RepositoryIntelligenceReport {
        return this.ensureSnapshot().headReport;
    }

    private ensureGraph(): BehavioralGraph {
        return this.ensureSnapshot().headGraph;
    }

    private ensureDiffAndRisk(): { diff: any; risks: any[] } {
        if (this.lastDiffReport && this.lastRiskReports.length > 0) {
            return { diff: this.lastDiffReport, risks: this.lastRiskReports };
        }
        const snap = this.ensureSnapshot();
        const diff = new BehavioralDiffEngine().computeDiff(snap.baseGraph, snap.headGraph);
        const risks = new RiskModelingEngine(this.projectRoot).assessRisk(diff, snap.headGraph);
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
        // Plugins execute repository code, so the MCP path never enables them
        // implicitly. An operator who wants them sets VERIS_ENABLE_PLUGINS on the
        // server process — a deliberate act with a visible configuration footprint.
        const plugins = loadPlugins(this.projectRoot);
        this.pluginsLoaded = plugins.loadedPlugins;
        this.pluginWarnings = plugins.warnings;
        classifier.ingestPluginRules(plugins.extraWorkflowRules);
        classifier.ingestExtraRuntimeRisks(plugins.extraRuntimeRisks);
        this.lastWorkflowReport = classifier.report(report, graph, diff, risks);
        return this.lastWorkflowReport;
    }

    private ensurePlan(): any {
        if (this.lastPlan) return this.lastPlan;
        const { risks } = this.ensureDiffAndRisk();
        this.lastPlan = new VerificationPlanningEngine(this.projectRoot).generatePlan(risks);
        return this.lastPlan;
    }

    private runId(): string {
        if (!this.lastRunId) this.lastRunId = this.state.newRunId();
        return this.lastRunId;
    }

    /**
     * Persist the run and its fingerprints.
     *
     * These were written only from the CLI, so under MCP — the primary integration —
     * no run row and no fingerprint row was ever created. `detect_drift` therefore
     * reported "first observation" forever, `confidence_history` returned `[]`
     * forever, and execution rows were orphans with no reachable parent run.
     */
    private persistRun(confidence?: { overallConfidence: number; executionDepth: number }): void {
        if (!this.state.enabled || this.runPersisted) return;
        const snap = this.lastSnapshot;
        const graph = this.currentGraph;
        if (!snap || !graph) return;

        const ts = new Date().toISOString();
        this.state.recordRun({
            runId: this.runId(),
            ts,
            diffMode: 'git',
            baseRef: snap.baseRef,
            headRef: snap.headRef,
            overallConfidence: confidence?.overallConfidence ?? 0,
            executionDepth: confidence?.executionDepth ?? 0,
            nodes: graph.getNodes().length,
            edges: graph.getEdges().length,
            workflows: this.lastWorkflowReport?.workflows.length ?? 0,
            impactedNodes: this.lastDiffReport?.impactedNodes.length ?? 0
        });
        for (const r of this.lastRiskReports) {
            this.state.recordNodeRisk(this.runId(), r.nodeId, r.score.overallRisk, r.score.blastRadius, ts);
        }
        this.runPersisted = true;
    }

    // --- handlers ---

    private handleAnalyzeRepository() {
        const r = this.ensureReport();
        const classCount = r.files.reduce((n, f) => n + f.classes.length, 0);
        const methodCount = r.files.reduce((n, f) => n + f.classes.reduce((m, c) => m + c.methods.length, 0), 0);
        const functionCount = r.files.reduce((n, f) => n + f.functions.length, 0);
        const exportedCount = r.files.reduce((n, f) => n + f.functions.filter(x => x.isExported).length, 0);

        const byPath = r.files
            .map(f => ({
                filePath: f.filePath,
                classes: f.classes.length,
                functions: f.functions.length,
                imports: f.imports.length
            }))
            .sort((a, b) => (b.classes + b.functions) - (a.classes + a.functions));
        const files = cap(byPath, CAPS.files);

        return this.text({
            fileCount: r.files.length,
            classCount,
            methodCount,
            functionCount,
            exportedFunctionCount: exportedCount,
            callResolution: {
                resolved: r.stats.callsResolved,
                singleCandidate: r.stats.callsHeuristic,
                ambiguousNoEdge: r.stats.callsAmbiguous,
                external: r.stats.callsExternal
            },
            analysisTruncated: r.stats.truncated,
            files: files.items,
            ...(files.truncated ? { truncated: files.truncated } : {})
        });
    }

    private handleExportGraph() {
        const g = this.ensureGraph();
        const wf = this.ensureWorkflows();
        const kindByNode = new Map<string, string>();
        for (const d of wf.workflows) {
            for (const id of d.memberNodeIds) kindByNode.set(id, d.kind);
        }
        const nodes = cap(g.getNodes().map(n => ({ ...n, workflowKind: kindByNode.get(n.id) ?? 'Uncategorized' })), CAPS.graphNodes);
        const edges = cap(g.getEdges(), CAPS.graphEdges);
        return this.text({
            nodeCount: g.getNodes().length,
            edgeCount: g.getEdges().length,
            nodes: nodes.items,
            edges: edges.items,
            ...(nodes.truncated || edges.truncated
                ? { truncated: { nodes: nodes.truncated ?? null, edges: edges.truncated ?? null } }
                : {})
        });
    }

    private handleAnalyzePr(args: any) {
        const snap = this.ensureSnapshot(args.baseRef);
        this.invalidateDerived();
        const { diff, risks } = this.ensureDiffAndRisk();
        const wf = this.ensureWorkflows();

        const affected = wf.aggregates
            .filter(a => a.impactedCount > 0 || a.addedCount > 0 || a.removedCount > 0)
            .slice(0, CAPS.workflows)
            .map(a => ({
                workflowId: a.workflowId, workflowName: a.workflowName,
                impactedCount: a.impactedCount, addedCount: a.addedCount, removedCount: a.removedCount,
                maxRisk: a.maxRisk, narrative: a.narrative
            }));

        const top = cap(risks.slice().sort((a, b) => b.score.overallRisk - a.score.overallRisk), CAPS.riskReports);

        this.persistRun();

        return this.text({
            baselineMode: 'git',
            baseRef: snap.baseRef,
            baseCommit: snap.baseCommit,
            headRef: snap.headRef,
            workingTreeDirty: snap.dirty,
            dirtyFileCount: snap.dirtyFileCount,
            addedNodes: diff.addedNodes.length,
            removedNodes: diff.removedNodes.length,
            modifiedNodes: diff.modifiedNodes.length,
            impactedNodes: diff.impactedNodes.length,
            affectedWorkflows: affected,
            topRisks: top.items,
            ...(top.truncated ? { truncated: { topRisks: top.truncated } } : {})
        });
    }

    private handleGeneratePlan() {
        const plan = this.ensurePlan();
        const byTier = (t: string) => plan.targets.filter((x: any) => x.tier.startsWith(t)).length;
        // Rank before capping: an arbitrary first-N slice of an unranked list is worse
        // than useless, because it looks like a priority order and is not one.
        const riskByNode = new Map(this.lastRiskReports.map((r: any) => [r.nodeId, r.score.overallRisk]));
        const ranked = plan.targets.slice().sort((a: any, b: any) =>
            (riskByNode.get(b.nodeId) ?? 0) - (riskByNode.get(a.nodeId) ?? 0));
        const targets = cap(ranked, CAPS.planTargets);
        return this.text({
            totalTargets: plan.targets.length,
            byTier: { tier1: byTier('Tier 1'), tier2: byTier('Tier 2'), tier3: byTier('Tier 3') },
            targets: targets.items,
            executionRecommendations: plan.executionRecommendations,
            ...(targets.truncated ? { truncated: targets.truncated, note: 'Targets are ranked by node risk; the highest-risk targets are shown.' } : {})
        });
    }

    private handleIdentifyUnverified(args: any) {
        const { risks } = this.ensureDiffAndRisk();
        const plan = this.ensurePlan();
        const confidence = new ConfidenceEngine().calculateConfidence(
            risks, plan, args.executedTargetsCount ?? 0,
            { state: this.state, projectRoot: this.projectRoot }
        );
        this.persistRun(confidence);
        return this.text(confidence);
    }

    private handleListWorkflows() {
        const wf = this.ensureWorkflows();
        const summary = wf.aggregates.slice(0, CAPS.workflows).map(a => ({
            workflowId: a.workflowId, workflowName: a.workflowName,
            memberCount: a.memberCount, impactedCount: a.impactedCount, addedCount: a.addedCount,
            averageRisk: a.averageRisk, maxRisk: a.maxRisk,
            narrative: a.narrative, runtimeRisks: a.runtimeRisks
        }));
        return this.text({
            workflowCount: wf.workflows.length,
            classification: 'weighted keyword vote over path, import and symbol tokens',
            workflows: summary,
            pluginsExecuted: this.pluginsLoaded,
            ...(this.pluginWarnings.length ? { pluginWarnings: this.pluginWarnings } : {}),
            ...(wf.aggregates.length > CAPS.workflows
                ? { truncated: { shown: CAPS.workflows, total: wf.aggregates.length } }
                : {})
        });
    }

    private handleAnalyzeWorkflow(args: any) {
        const wf = this.ensureWorkflows();
        const d = wf.workflows.find(w => w.id === args.workflowId);
        const a = wf.aggregates.find(x => x.workflowId === args.workflowId);
        if (!d || !a) {
            return this.error(`Workflow '${args.workflowId}' not found. Available: ${wf.workflows.map(w => w.id).join(', ')}`);
        }
        const members = cap(d.memberNodeIds, CAPS.graphNodes);
        return this.text({
            workflow: {
                id: d.id, name: d.name, kind: d.kind,
                memberCount: d.memberNodeIds.length,
                classificationScore: d.confidence,
                signals: d.signals,
                members: members.items,
                ...(members.truncated ? { membersTruncated: members.truncated } : {})
            },
            impact: { ...a, topRisks: a.topRisks.slice(0, 5) }
        });
    }

    private handleDetectDrift() {
        const wf = this.ensureWorkflows();
        const graph = this.ensureGraph();
        const fps = new WorkflowFingerprintEngine().fingerprintAll(wf.workflows, graph);
        this.lastFingerprints = fps;
        const drift = new DriftDetector().detect(this.runId(), fps, this.state);

        // Persist the run first so the fingerprints have a parent row, then the
        // fingerprints themselves — without this, every call is a first observation.
        this.persistRun();
        if (this.state.enabled) {
            const ts = new Date().toISOString();
            for (const fp of fps) {
                this.state.recordFingerprint({
                    workflowId: fp.workflowId, runId: this.runId(),
                    fingerprint: fp.fingerprint, memberCount: fp.memberCount, ts
                });
            }
        }
        return this.text(drift);
    }

    private handleGenerateProbes() {
        const wf = this.ensureWorkflows();
        const { risks } = this.ensureDiffAndRisk();
        const probes = new AdversarialProbeGenerator(this.projectRoot)
            .generate(risks, wf.workflows, this.ensureGraph().getNodes());
        const c = cap(probes, CAPS.probes);
        return this.text({
            probeCount: probes.length,
            probes: c.items,
            ...(c.truncated ? { truncated: c.truncated } : {})
        });
    }

    private handleAllocateBudget(args: any) {
        const plan = this.ensurePlan();
        const wf = this.ensureWorkflows();
        const { risks } = this.ensureDiffAndRisk();
        const allocation = new VerificationBudgetAllocator(this.projectRoot)
            .allocate(plan, risks, wf.workflows, args.minutes);
        const selected = cap(allocation.selected, CAPS.budgetSelected);
        // `skipped` is the complement of the selection — on a large repo it is the
        // whole plan minus a handful of items, and returning it drove this response
        // to 16.3 MB. The count is the useful part.
        return this.text({
            budgetMinutes: args.minutes,
            budgetSec: allocation.budgetSec,
            totalEstimatedSec: allocation.totalEstimatedSec,
            coverage: allocation.coverage,
            narrative: allocation.narrative,
            selectedCount: allocation.selected.length,
            skippedCount: allocation.skipped.length,
            selected: selected.items,
            ...(selected.truncated ? { truncated: selected.truncated } : {})
        });
    }

    private handleWhatIfRevert(args: any) {
        const snap = this.ensureSnapshot();
        const result = new CounterfactualEngine(this.projectRoot)
            .whatIfRevert(snap.baseGraph, snap.headGraph, args.nodeIds);
        return this.text({ baselineMode: 'git', baseRef: snap.baseRef, baseCommit: snap.baseCommit, ...result });
    }

    /**
     * Ingests execution evidence.
     *
     * The caller is typically the agent whose work is being assessed, so every record
     * is stamped with a trust class and defaults to `agent-asserted` — the weakest.
     * A caller may claim `harness-observed`, and that claim is itself recorded
     * alongside the producer identity rather than being taken as fact; the value of
     * the log is that the claim is attributable, not that it is believed.
     */
    private handleReportExecution(args: any) {
        const executions = args.executions as any[];
        const now = new Date().toISOString();
        const runId = this.runId();

        const rows: ExecutionRecord[] = executions.map((e: any) => ({
            runId,
            nodeId: e.nodeId,
            workflowId: e.workflowId ?? null,
            tier: e.tier,
            directive: e.directive ?? '',
            result: e.result,
            detail: e.detail,
            durationMs: e.durationMs,
            executedAt: e.executedAt ?? now,
            trustClass: (e.trustClass as TrustClass) ?? 'agent-asserted',
            producer: e.producer ?? 'mcp-client'
        }));

        // One transaction: a malformed entry mid-batch previously left earlier rows
        // committed and returned an error, so the caller could not know what landed.
        const recorded = this.state.recordExecutions(rows);
        this.persistRun();

        return this.text({
            recorded,
            runId,
            trustClasses: rows.reduce((acc: Record<string, number>, r) => {
                const k = r.trustClass ?? 'agent-asserted';
                acc[k] = (acc[k] ?? 0) + 1;
                return acc;
            }, {}),
            note: 'Evidence is append-only and hash-chained. Earlier records for the same target are retained, not replaced.'
        });
    }

    private handleConfidenceHistory(args: any) {
        const limit = Math.min(args.limit ?? 30, CAPS.history);
        const trend = this.state.confidenceTrend(limit);
        return this.text({
            runCount: trend.length,
            limit,
            stateEnabled: this.state.enabled,
            trend
        });
    }

    private handleNodeHistory(args: any) {
        const risk = this.state.nodeRiskHistory(args.nodeId, CAPS.history);
        const evidence = this.state.executionsForNode(args.nodeId).slice(0, CAPS.history);
        return this.text({
            nodeId: args.nodeId,
            riskHistory: risk,
            executionEvidence: evidence.map(e => ({
                runId: e.runId, tier: e.tier, result: e.result,
                trustClass: e.trustClass, producer: e.producer,
                executedAt: e.executedAt, detail: e.detail
            }))
        });
    }

    private handleExportOnboarding() {
        const wf = this.ensureWorkflows();
        const result = new OnboardingExporter().export(this.projectRoot, wf, this.ensureGraph());
        return this.text(result);
    }

    private handleCrossRepoSnapshot() {
        return this.text(new CrossRepoRegistry().snapshot());
    }

    private handleRegisterRepo(args: any) {
        try {
            return this.text(new CrossRepoRegistry().register(args.name, args.path, args.tags));
        } catch (e) {
            return this.error((e as Error).message);
        }
    }

    async run() {
        const transport = new StdioServerTransport();

        const shutdown = () => {
            // Without this the write-ahead log is never checkpointed and grows across
            // every session.
            try { this.state.close(); } catch { /* best effort */ }
            process.exit(0);
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);

        await this.server.connect(transport);
        console.error(`Veris MCP Server ${VERIS_VERSION} running on stdio (root: ${this.projectRoot})`);
    }
}
