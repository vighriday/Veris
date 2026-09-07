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
import { GitDiffDriver, BaselineError } from './engine/GitDiffDriver';
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
import { VERIS_VERSION } from './version';

interface CliArgs {
    targetDir: string;
    baseRef?: string;
    budget?: number;
    withOnboarding: boolean;
    watch: boolean;
    quiet: boolean;
    allowPlugins: boolean;
    command: 'analyze' | 'init' | 'help' | 'doctor' | 'schema' | 'mcp' | 'version';
}

export class CliUsageError extends Error {}

const SUBCOMMANDS = ['analyze', 'init', 'doctor', 'schema', 'mcp', 'version', 'help'] as const;

/**
 * `analyze` is an explicit subcommand, not a fallthrough. Previously any
 * non-flag token was treated as a target path, so `veris analyze` resolved
 * `./analyze`, found nothing, and exited 0 — the exact invocation skill.json
 * advertises. A token that is neither a known subcommand nor an existing
 * directory is now a usage error rather than a silent no-op.
 */
function parseArgs(argv: string[]): CliArgs {
    const args = argv.slice(2);
    const base = { withOnboarding: false, watch: false, quiet: false, allowPlugins: false };

    if (args[0] === 'init')    return { ...base, command: 'init', targetDir: args[1] ? path.resolve(args[1]) : process.cwd() };
    if (args[0] === 'doctor')  return { ...base, command: 'doctor', targetDir: args[1] ? path.resolve(args[1]) : process.cwd() };
    if (args[0] === 'schema')  return { ...base, command: 'schema', targetDir: process.cwd() };
    if (args[0] === 'mcp')     return { ...base, command: 'mcp', targetDir: process.cwd() };
    if (args[0] === 'version' || args[0] === '--version' || args[0] === '-v') return { ...base, command: 'version', targetDir: process.cwd() };
    if (args[0] === 'help' || args[0] === '--help' || args[0] === '-h') return { ...base, command: 'help', targetDir: process.cwd() };

    let targetDir: string | null = null;
    let baseRef: string | undefined;
    let budget: number | undefined;
    let withOnboarding = false;
    let watch = false;
    let quiet = false;
    let allowPlugins = false;

    // `veris analyze [path]` and bare `veris [path]` are both accepted.
    const positional = args[0] === 'analyze' ? args.slice(1) : args;

    for (const a of positional) {
        if (a.startsWith('--base-ref=')) {
            baseRef = a.slice('--base-ref='.length);
            if (!baseRef) throw new CliUsageError('--base-ref requires a value, e.g. --base-ref=origin/main');
        } else if (a.startsWith('--budget=')) {
            const raw = a.slice('--budget='.length);
            budget = Number(raw);
            if (!Number.isFinite(budget) || budget <= 0) {
                throw new CliUsageError(`--budget must be a positive number of minutes, got ${JSON.stringify(raw)}`);
            }
        } else if (a === '--onboarding') withOnboarding = true;
        else if (a === '--watch') watch = true;
        else if (a === '--quiet' || a === '-q') quiet = true;
        else if (a === '--allow-plugins') allowPlugins = true;
        else if (a.startsWith('-')) {
            throw new CliUsageError(`Unknown flag ${JSON.stringify(a)}. Run \`veris help\` for usage.`);
        } else if (targetDir === null) {
            targetDir = path.resolve(a);
        } else {
            throw new CliUsageError(`Unexpected extra argument ${JSON.stringify(a)}. Only one target path is accepted.`);
        }
    }

    const resolved = targetDir ?? process.cwd();
    if (!fs.existsSync(resolved)) {
        const hint = SUBCOMMANDS.includes(path.basename(resolved) as any)
            ? ` Did you mean \`veris ${path.basename(resolved)}\`?`
            : '';
        throw new CliUsageError(`Target path does not exist: ${resolved}.${hint}`);
    }
    if (!fs.statSync(resolved).isDirectory()) {
        throw new CliUsageError(`Target path is not a directory: ${resolved}`);
    }

    return { command: 'analyze', targetDir: resolved, baseRef, budget, withOnboarding, watch, quiet, allowPlugins };
}

function printHelp() {
    console.log(`Veris ${VERIS_VERSION} - Behavioral Verification Infrastructure

Usage:
  veris analyze [path]                 Analyze repo at path (default: cwd)
  veris [path]                         Same as \`veris analyze\`
  veris init [path]                    Scaffold .veris/ in a new project
  veris doctor [path]                  Health check (deps, state, git, plugins)
  veris schema                         Print public JSON Schemas for tool outputs
  veris mcp                            Start the MCP server on stdio
  veris version                        Print version
  veris help                           This message

Analyze flags:
  --base-ref=<ref>                     Git base ref for diff (default: origin/main, HEAD~1)
  --budget=<minutes>                   Allocate verification budget (default: 15)
  --onboarding                         Also write workflow onboarding map
  --watch                              Re-run on file change (debounced)
  --quiet                              Reduce log output
  --allow-plugins                      Execute .veris/plugins/*.js from the target repo

Env:
  VERIS_CONFIDENCE_THRESHOLD           Exit code 2 below this confidence
  VERIS_STATE_DISABLED=1               Skip SQLite state (zero-retention mode)
  VERIS_ENABLE_PLUGINS=1               Same as --allow-plugins

Analysis requires a git repository with a resolvable base ref. Veris compares
your working tree against the merge-base with that ref; it never fabricates a
baseline. If no base ref resolves, the run fails with an explanation.

Plugins execute code from the analyzed repository and are OFF by default. Only
enable them for repositories you trust.

Docs: https://github.com/vighriday/Veris
`);
}

function runDoctor(targetDir: string) {
    const out: Array<{ check: string; ok: boolean; detail: string }> = [];
    out.push({ check: 'Node version', ok: parseInt(process.version.slice(1).split('.')[0], 10) >= 18, detail: process.version });
    out.push({ check: 'Project root readable', ok: fs.existsSync(targetDir), detail: targetDir });
    const pkg = path.join(targetDir, 'package.json');
    out.push({ check: 'package.json present', ok: fs.existsSync(pkg), detail: pkg });
    const gitDriver = new GitDiffDriver(targetDir);
    const isGit = gitDriver.isGitRepo();
    out.push({ check: 'Git repository', ok: isGit, detail: isGit ? 'detected' : 'not a git repo — analysis cannot run (Veris never fabricates a baseline)' });

    // Baseline resolution is a hard requirement for analysis, so doctor reports it
    // rather than letting the user discover it mid-run.
    if (isGit) {
        const resolution = gitDriver.resolveBase();
        out.push({
            check: 'Base ref',
            ok: resolution.ok,
            detail: resolution.ok
                ? `${resolution.baseRef} → merge-base ${resolution.mergeBase.slice(0, 12)}`
                : `${resolution.reason} — pass --base-ref=<ref>`
        });
    }

    const verisDir = path.join(targetDir, '.veris');
    out.push({ check: '.veris directory', ok: fs.existsSync(verisDir), detail: fs.existsSync(verisDir) ? verisDir : 'run `veris init` to scaffold' });
    const pluginsDir = path.join(verisDir, 'plugins');
    const pluginCount = fs.existsSync(pluginsDir) ? fs.readdirSync(pluginsDir).filter(f => /\.(js|mjs|cjs)$/.test(f)).length : 0;
    const pluginsEnabled = process.env.VERIS_ENABLE_PLUGINS === '1';
    out.push({
        check: 'Plugins',
        ok: true,
        detail: pluginCount === 0
            ? 'none present'
            : `${pluginCount} present, ${pluginsEnabled ? 'ENABLED via VERIS_ENABLE_PLUGINS' : 'disabled (pass --allow-plugins to execute)'}`
    });
    // Optional: a missing native binding means no history, not a broken install, so
    // it must not read as a failed check.
    const sqlite = !!safeRequire('better-sqlite3');
    out.push({
        check: 'better-sqlite3 (optional)',
        ok: true,
        detail: sqlite
            ? 'available — run history and drift enabled'
            : 'not installed — analysis works, history and drift disabled'
    });
    out.push({ check: 'ts-morph', ok: !!safeRequire('ts-morph'), detail: safeRequire('ts-morph') ? 'available' : 'missing (npm install)' });

    console.log(`Veris doctor — ${out.filter(x => x.ok).length}/${out.length} checks passed`);
    for (const c of out) console.log(`  ${c.ok ? '✓' : '✗'} ${c.check}: ${c.detail}`);
}

function safeRequire(mod: string): any {
    try { return require(mod); } catch { return null; }
}

function runSchema() {
    const { ALL_SCHEMAS } = require('./schema/PublicSchema');
    console.log(JSON.stringify(ALL_SCHEMAS, null, 2));
}

function runMcp() {
    const { VerisMcpServer } = require('./mcp/McpServer');
    const server = new VerisMcpServer();
    server.run().catch((e: Error) => { console.error(e); process.exit(1); });
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
    let args: CliArgs;
    try {
        args = parseArgs(process.argv);
    } catch (e) {
        if (e instanceof CliUsageError) {
            console.error(`veris: ${e.message}`);
            process.exit(2);
        }
        throw e;
    }

    if (args.command === 'help')    { printHelp(); return; }
    if (args.command === 'version') { console.log(VERIS_VERSION); return; }
    if (args.command === 'init')    { runInit(args.targetDir); return; }
    if (args.command === 'doctor')  { runDoctor(args.targetDir); return; }
    if (args.command === 'schema')  { runSchema(); return; }
    if (args.command === 'mcp')     { runMcp(); return; }

    if (args.watch) {
        const { WatchMode } = require('./engine/WatchMode');
        await analyzeOnce(args);
        const w = new WatchMode(args.targetDir, async (changed: string[]) => {
            console.log(`\n-> Change detected (${changed.slice(0, 3).join(', ')}${changed.length > 3 ? ', ...' : ''}). Re-analyzing.`);
            try { await analyzeOnce(args); } catch (e) { console.error('Re-analyze failed:', e); }
        });
        w.start();
        console.log(`\n-> Watch mode active. Ctrl+C to stop.`);
        return;
    }

    return analyzeOnce(args);
}

async function analyzeOnce(args: CliArgs) {
    if (!args.quiet) {
        console.log("==================================================");
        console.log(`Veris ${VERIS_VERSION} - Behavioral Verification Infrastructure`);
        console.log("==================================================");
        console.log(`Target Directory: ${args.targetDir}`);
        if (args.baseRef) console.log(`Base Ref Hint: ${args.baseRef}`);
        console.log();
    }

    try {
        // Plugin layer. Off unless explicitly enabled: plugins are code from the
        // repository under analysis.
        const plugins = loadPlugins(args.targetDir, { allowExecution: args.allowPlugins });
        if (plugins.loadedPlugins.length > 0) {
            console.log(`-> Plugins executed: ${plugins.loadedPlugins.join(', ')}`);
        }
        for (const w of plugins.warnings) console.warn(`-> ${w}`);

        // State
        const state = new VerisState(args.targetDir);
        const runId = state.newRunId();

        // Baseline + head graphs. There is no fallback: if a baseline cannot be
        // established the run fails with a reason rather than inventing one.
        console.log("-> Establishing baseline and analyzing head...");
        const gitDriver = new GitDiffDriver(args.targetDir);
        const snap = gitDriver.snapshot(args.baseRef);
        const diffMode = 'git';
        const headReport: RepositoryIntelligenceReport = snap.headReport;
        const headGraph: BehavioralGraph = snap.headGraph;
        const baseGraph: BehavioralGraph = snap.baseGraph;

        console.log(`-> Baseline: ${snap.baseRef} @ ${snap.baseCommit.slice(0, 12)} -> head ${snap.headRef}`);
        if (snap.dirty) {
            console.log(`   Working tree has ${snap.dirtyFileCount} uncommitted change${snap.dirtyFileCount === 1 ? '' : 's'}; this run is not reproducible from commits alone.`);
        }
        console.log(`-> Graph: ${headGraph.getNodes().length} nodes, ${headGraph.getEdges().length} edges (head), ${snap.trackedFileCount} tracked files`);

        const hs = snap.headStats;
        const totalCalls = hs.callsResolved + hs.callsHeuristic + hs.callsAmbiguous;
        if (totalCalls > 0) {
            const pct = ((hs.callsResolved / totalCalls) * 100).toFixed(1);
            console.log(`-> Call resolution: ${hs.callsResolved} resolved (${pct}%), ${hs.callsHeuristic} single-candidate, ${hs.callsAmbiguous} ambiguous (no edge emitted)`);
        }
        if (hs.truncated) {
            console.warn('-> WARNING: analysis truncated by file limit; graph is incomplete.');
        }

        // Phase 3
        console.log("-> Calculating Risk Models...");
        const diffEngine = new BehavioralDiffEngine();
        const diffReport = diffEngine.computeDiff(baseGraph, headGraph);
        const riskEngine = new RiskModelingEngine(args.targetDir);
        const riskReports = riskEngine.assessRisk(diffReport, headGraph);

        // Phase 2.5 — Workflows
        console.log("-> Classifying Behavioral Workflows...");
        const classifier = new WorkflowClassifier(args.targetDir);
        classifier.ingestPluginRules(plugins.extraWorkflowRules);
        classifier.ingestExtraRuntimeRisks(plugins.extraRuntimeRisks);
        const workflowReport = classifier.report(headReport, headGraph, diffReport, riskReports);
        console.log(`-> Workflows: ${workflowReport.workflows.length} detected, ${workflowReport.aggregates.filter(w => w.impactedCount > 0).length} affected in diff`);

        // Fingerprints + drift
        const fpEngine = new WorkflowFingerprintEngine();
        const fingerprints = fpEngine.fingerprintAll(workflowReport.workflows, headGraph);
        const drift = new DriftDetector().detect(runId, fingerprints, state);

        // Probes
        const probeGen = new AdversarialProbeGenerator(args.targetDir);
        const probes = probeGen.generate(riskReports, workflowReport.workflows, headGraph.getNodes());
        console.log(`-> Adversarial probes generated: ${probes.length}`);

        // Phase 4 & 5
        console.log("-> Planning Verification...");
        const planningEngine = new VerificationPlanningEngine();
        const plan = planningEngine.generatePlan(riskReports);

        console.log("-> Assessing Confidence (with state-aware decay)...");
        const confidenceEngine = new ConfidenceEngine();
        const confidence = confidenceEngine.calculateConfidence(riskReports, plan, 0, { state, projectRoot: args.targetDir });

        // Budget
        const budgetMin = args.budget ?? 15;
        const budget = new VerificationBudgetAllocator(args.targetDir).allocate(plan, riskReports, workflowReport.workflows, budgetMin);

        // Persist this run
        const ts = new Date().toISOString();
        state.recordRun({
            runId, ts, diffMode,
            baseRef: snap.baseRef,
            headRef: snap.headRef,
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
            baseRef: snap.baseRef,
            baseCommit: snap.baseCommit,
            headRef: snap.headRef,
            dirty: snap.dirty,
            dirtyFileCount: snap.dirtyFileCount,
            projectRoot: args.targetDir,
            generatedAt: ts,
            stats: snap.headStats
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
        if (state.active) {
            console.log(`- State: ${state.dbPath}`);
        } else if (state.enabled) {
            console.log(`- State: not written (better-sqlite3 unavailable) — history and drift disabled this run`);
        }

        state.close();

        const threshold = Number(process.env.VERIS_CONFIDENCE_THRESHOLD || '0');
        if (threshold > 0 && confidence.overallConfidence < threshold) {
            console.error(`\nVeris gate failed: confidence ${confidence.overallConfidence} < threshold ${threshold}`);
            process.exit(2);
        }

    } catch (e) {
        const err = e as Error;
        if (err instanceof BaselineError) {
            // Deliberately fatal. Veris compares against a real prior state or it does
            // not answer; there is no fabricated baseline to fall back to.
            console.error(`\nVeris cannot analyze this repository: ${err.message}`);
            console.error("\nA behavioral diff requires a real baseline. Options:");
            console.error("  - Run inside a git repository with at least one commit");
            console.error("  - Pass an explicit ref: --base-ref=HEAD~1 or --base-ref=origin/develop");
            console.error("  - In shallow CI checkouts, fetch history: actions/checkout with fetch-depth: 0");
            process.exit(3);
        }
        console.error("\nVeris CLI Error.");
        console.error("Message:", err.message);
        if (err.message && err.message.includes('better-sqlite3')) {
            console.error("\nHint: native module 'better-sqlite3' failed to load. Try:");
            console.error("  npm rebuild better-sqlite3");
            console.error("  Or run with VERIS_STATE_DISABLED=1 to skip persistence.");
        } else if (err.message && err.message.toLowerCase().includes('git')) {
            console.error("\nHint: a git operation failed. Check `git status` works in this directory,");
            console.error("  or pass an explicit --base-ref=HEAD~1.");
        } else if (err.message && err.message.includes('data/')) {
            console.error("\nHint: missing default data files. Try `npm rebuild` or reinstall veris-core.");
        }
        if (process.env.VERIS_DEBUG === '1') {
            console.error("\nStack:", err.stack);
        } else {
            console.error("\nRun with VERIS_DEBUG=1 for full stack trace.");
        }
        process.exit(1);
    }
}

runCli();
