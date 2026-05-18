#!/usr/bin/env node
import * as path from 'path';
import * as fs from 'fs';
import { RepositoryIntelligenceEngine } from './engine/RepositoryIntelligenceEngine';
import { BehavioralGraphEngine } from './engine/BehavioralGraphEngine';
import { BehavioralDiffEngine } from './engine/BehavioralDiffEngine';
import { RiskModelingEngine } from './engine/RiskModelingEngine';
import { VerificationPlanningEngine } from './engine/VerificationPlanningEngine';
import { ConfidenceEngine } from './engine/ConfidenceEngine';
import { ReportingEngine } from './reporting/ReportingEngine';
import { GitDiffDriver } from './engine/GitDiffDriver';
import { BehavioralGraph } from './models/GraphModels';
import { WorkflowClassifier } from './engine/WorkflowClassifier';
import { WorkflowFingerprintEngine } from './engine/WorkflowFingerprint';
import { DriftDetector } from './engine/DriftDetector';
import { AdversarialProbeGenerator } from './engine/AdversarialProbeGenerator';
import { VerificationBudgetAllocator } from './engine/VerificationBudgetAllocator';
import { OnboardingExporter } from './engine/OnboardingExporter';
import { RepositoryIntelligenceReport } from './models/EntityModels';
import { VerisState } from './persistence/VerisState';
import { loadPlugins } from './plugins/PluginLoader';

interface CliArgs {
    targetDir: string;
    baseRef?: string;
    budget?: number;
    withOnboarding: boolean;
    command: 'analyze' | 'init' | 'help';
}

function parseArgs(argv: string[]): CliArgs {
    const args = argv.slice(2);
    let targetDir = process.cwd();
    let baseRef: string | undefined;
    let budget: number | undefined;
    let withOnboarding = false;
    let command: CliArgs['command'] = 'analyze';

    if (args[0] === 'init') return { command: 'init', targetDir: args[1] ? path.resolve(args[1]) : process.cwd(), withOnboarding: false };
    if (args[0] === 'help' || args[0] === '--help' || args[0] === '-h') return { command: 'help', targetDir, withOnboarding: false };

    for (const a of args) {
        if (a.startsWith('--base-ref=')) baseRef = a.split('=')[1];
        else if (a.startsWith('--budget=')) budget = parseInt(a.split('=')[1], 10);
        else if (a === '--onboarding') withOnboarding = true;
        else if (a.startsWith('--')) continue;
        else targetDir = path.resolve(a);
    }
    return { command, targetDir, baseRef, budget, withOnboarding };
}

function printHelp() {
    console.log(`Veris - Behavioral Verification Infrastructure

Usage:
  veris [path]                         Analyze repo at path (default: cwd)
  veris init [path]                    Scaffold .veris/ in a new project
  veris help                           This message

Analyze flags:
  --base-ref=<ref>                     Git base ref for diff (default: origin/main, HEAD~1)
  --budget=<minutes>                   Allocate verification budget (default: 15)
  --onboarding                         Also write workflow onboarding map

Env:
  VERIS_CONFIDENCE_THRESHOLD           Exit code 2 below this confidence
  VERIS_STATE_DISABLED=1               Skip SQLite state (zero-retention mode)
  VERIS_PLUGINS_DISABLED=1             Skip .veris/plugins
`);
}

function runInit(targetDir: string) {
    const dir = path.join(targetDir, '.veris');
    const plugins = path.join(dir, 'plugins');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(plugins)) fs.mkdirSync(plugins, { recursive: true });

    const samplePath = path.join(plugins, 'example.js.disabled');
    const sample = `// Example Veris plugin. Rename to example.js to enable.
// Plugins are local Node modules. Each exports register(api).

module.exports.register = function (api) {
  api.log('example plugin registered');

  // Add a custom workflow classifier rule
  api.addWorkflowRule({
    kind: 'Billing',
    pathTokens: ['stripe-internal'],
    importTokens: ['@yourorg/billing-sdk'],
    symbolTokens: ['invoiceLineItem'],
    weight: 2
  });

  // Add custom runtime risks to an existing workflow kind
  api.addRuntimeRisks('Billing', [
    'proration drift on plan downgrade within trial window'
  ]);
};
`;
    if (!fs.existsSync(samplePath)) fs.writeFileSync(samplePath, sample, 'utf8');

    const cfg = path.join(dir, 'config.json');
    if (!fs.existsSync(cfg)) {
        fs.writeFileSync(cfg, JSON.stringify({
            version: 1,
            confidenceThreshold: 0,
            defaultBaseRef: null,
            zeroRetention: false
        }, null, 2), 'utf8');
    }
    console.log(`Veris initialized at ${dir}`);
    console.log(`  - plugins/        (drop *.js files exporting register(api))`);
    console.log(`  - config.json     (project-level settings)`);
    console.log(`  - state.db        (created on first run)`);
    console.log(`\nRename plugins/example.js.disabled to plugins/example.js to enable the sample plugin.`);
}

async function runCli() {
    const args = parseArgs(process.argv);

    if (args.command === 'help') { printHelp(); return; }
    if (args.command === 'init') { runInit(args.targetDir); return; }

    console.log("==================================================");
    console.log("Veris - Behavioral Verification Infrastructure");
    console.log("==================================================");
    console.log(`Target Directory: ${args.targetDir}`);
    if (args.baseRef) console.log(`Base Ref Hint: ${args.baseRef}`);
    console.log();

    try {
        // Plugin layer
        const plugins = loadPlugins(args.targetDir);
        if (plugins.loadedPlugins.length > 0) {
            console.log(`-> Plugins loaded: ${plugins.loadedPlugins.join(', ')}`);
        }

        // State
        const state = new VerisState(args.targetDir);
        const runId = state.newRunId();

        // Phase 1
        console.log("-> Running Intelligence Engine on head...");
        const intel = new RepositoryIntelligenceEngine(args.targetDir);
        const headReport: RepositoryIntelligenceReport = intel.analyze();
        const ge = new BehavioralGraphEngine();
        const headGraph: BehavioralGraph = ge.buildGraphFromReport(headReport);

        // Git diff
        const gitDriver = new GitDiffDriver(args.targetDir);
        let baseGraph: BehavioralGraph;
        let diffMode = 'synthetic';
        const snap = gitDriver.snapshot(args.baseRef);
        if (snap) {
            console.log(`-> Git diff mode: ${snap.baseRef} -> ${snap.headRef}`);
            baseGraph = snap.baseGraph;
            diffMode = 'git';
        } else {
            console.log("-> Git diff unavailable. Falling back to synthetic 70% slice.");
            baseGraph = new BehavioralGraph();
            headGraph.getNodes().slice(0, Math.floor(headGraph.getNodes().length * 0.7)).forEach(n => baseGraph.addNode(n));
            headGraph.getEdges().slice(0, Math.floor(headGraph.getEdges().length * 0.7)).forEach(e => baseGraph.addEdge(e));
        }

        console.log(`-> Graph: ${headGraph.getNodes().length} nodes, ${headGraph.getEdges().length} edges (head)`);

        // Phase 3
        console.log("-> Calculating Risk Models...");
        const diffEngine = new BehavioralDiffEngine();
        const diffReport = diffEngine.computeDiff(baseGraph, headGraph);
        const riskEngine = new RiskModelingEngine();
        const riskReports = riskEngine.assessRisk(diffReport, headGraph);

        // Phase 2.5 — Workflows
        console.log("-> Classifying Behavioral Workflows...");
        const classifier = new WorkflowClassifier();
        classifier.ingestPluginRules(plugins.extraWorkflowRules);
        classifier.ingestExtraRuntimeRisks(plugins.extraRuntimeRisks);
        const workflowReport = classifier.report(headReport, headGraph, diffReport, riskReports);
        console.log(`-> Workflows: ${workflowReport.workflows.length} detected, ${workflowReport.aggregates.filter(w => w.impactedCount > 0).length} affected in diff`);

        // Fingerprints + drift
        const fpEngine = new WorkflowFingerprintEngine();
        const fingerprints = fpEngine.fingerprintAll(workflowReport.workflows, headGraph);
        const drift = new DriftDetector().detect(runId, fingerprints, state);

        // Probes
        const probeGen = new AdversarialProbeGenerator();
        const probes = probeGen.generate(riskReports, workflowReport.workflows, headGraph.getNodes());
        console.log(`-> Adversarial probes generated: ${probes.length}`);

        // Phase 4 & 5
        console.log("-> Planning Verification...");
        const planningEngine = new VerificationPlanningEngine();
        const plan = planningEngine.generatePlan(riskReports);

        console.log("-> Assessing Confidence (with state-aware decay)...");
        const confidenceEngine = new ConfidenceEngine();
        const confidence = confidenceEngine.calculateConfidence(riskReports, plan, 0, { state });

        // Budget
        const budgetMin = args.budget ?? 15;
        const budget = new VerificationBudgetAllocator().allocate(plan, riskReports, workflowReport.workflows, budgetMin);

        // Persist this run
        const ts = new Date().toISOString();
        state.recordRun({
            runId, ts, diffMode,
            baseRef: snap?.baseRef ?? null,
            headRef: snap?.headRef ?? null,
            overallConfidence: confidence.overallConfidence,
            executionDepth: confidence.executionDepth,
            nodes: headGraph.getNodes().length,
            edges: headGraph.getEdges().length,
            workflows: workflowReport.workflows.length,
            impactedNodes: diffReport.impactedNodes.length
        });
        for (const fp of fingerprints) {
            state.recordFingerprint({
                workflowId: fp.workflowId, runId, fingerprint: fp.fingerprint,
                memberCount: fp.memberCount, ts
            });
        }
        for (const r of riskReports) {
            state.recordNodeRisk(runId, r.nodeId, r.score.overallRisk, r.score.blastRadius, ts);
        }
        const trend = state.confidenceTrend(30);

        // Optional onboarding export
        if (args.withOnboarding) {
            const onboarding = new OnboardingExporter().export(args.targetDir, workflowReport, headGraph);
            console.log(`-> Onboarding map: ${onboarding.indexPath}`);
        }

        // Reports
        console.log("-> Generating Reports...");
        const reportingEngine = new ReportingEngine(args.targetDir);
        const meta = {
            diffMode,
            baseRef: snap?.baseRef,
            headRef: snap?.headRef,
            projectRoot: args.targetDir,
            generatedAt: ts
        };
        const mdPath = reportingEngine.generateMarkdownReport(diffReport, riskReports, plan, confidence, meta);
        const dashboardPath = reportingEngine.generateDashboard({
            meta,
            graph: { nodes: headGraph.getNodes(), edges: headGraph.getEdges() },
            diff: diffReport,
            risks: riskReports,
            plan,
            confidence,
            workflows: workflowReport,
            drift,
            fingerprints,
            probes,
            budget,
            confidenceTrend: trend,
            pluginsLoaded: plugins.loadedPlugins,
            runId
        });

        console.log(`\nDiff Mode: ${diffMode}`);
        console.log(`Run ID: ${runId}`);
        console.log(`Reports generated:`);
        console.log(`- Markdown: ${mdPath}`);
        console.log(`- Interactive dashboard: ${dashboardPath}`);
        if (state.enabled) console.log(`- State: ${state.dbPath}`);

        state.close();

        const threshold = Number(process.env.VERIS_CONFIDENCE_THRESHOLD || '0');
        if (threshold > 0 && confidence.overallConfidence < threshold) {
            console.error(`\nVeris gate failed: confidence ${confidence.overallConfidence} < threshold ${threshold}`);
            process.exit(2);
        }

    } catch (e) {
        console.error("Veris CLI Error:", e);
        process.exit(1);
    }
}

runCli();
