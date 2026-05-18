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

interface CliArgs {
    targetDir: string;
    baseRef?: string;
}

function parseArgs(argv: string[]): CliArgs {
    const args = argv.slice(2);
    let targetDir = process.cwd();
    let baseRef: string | undefined;
    for (const a of args) {
        if (a.startsWith('--base-ref=')) baseRef = a.split('=')[1];
        else if (a.startsWith('--')) continue;
        else targetDir = path.resolve(a);
    }
    return { targetDir, baseRef };
}

async function runCli() {
    console.log("==================================================");
    console.log("Veris CLI - Behavioral Verification Infrastructure");
    console.log("==================================================");

    const { targetDir, baseRef } = parseArgs(process.argv);
    console.log(`Target Directory: ${targetDir}`);
    if (baseRef) console.log(`Base Ref Hint: ${baseRef}`);
    console.log();

    try {
        // Try real git-diff path first
        const gitDriver = new GitDiffDriver(targetDir);
        let baseGraph: BehavioralGraph;
        let headGraph: BehavioralGraph;
        let diffMode = 'synthetic';
        const snap = gitDriver.snapshot(baseRef);

        if (snap) {
            console.log(`-> Git diff mode: ${snap.baseRef} -> ${snap.headRef}`);
            baseGraph = snap.baseGraph;
            headGraph = snap.headGraph;
            diffMode = 'git';
        } else {
            console.log("-> Git diff unavailable. Falling back to synthetic 70% slice.");
            const intel = new RepositoryIntelligenceEngine(targetDir);
            const report = intel.analyze();
            const ge = new BehavioralGraphEngine();
            headGraph = ge.buildGraphFromReport(report);
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

        // Phase 4 & 5
        console.log("-> Planning Verification...");
        const planningEngine = new VerificationPlanningEngine();
        const plan = planningEngine.generatePlan(riskReports);

        console.log("-> Assessing Confidence...");
        const confidenceEngine = new ConfidenceEngine();
        const confidence = confidenceEngine.calculateConfidence(riskReports, plan, 0);

        // Phase 6
        console.log("-> Generating Reports...");
        const reportingEngine = new ReportingEngine(targetDir);
        const meta = {
            diffMode,
            baseRef: snap?.baseRef,
            headRef: snap?.headRef,
            projectRoot: targetDir,
            generatedAt: new Date().toISOString()
        };
        const mdPath = reportingEngine.generateMarkdownReport(diffReport, riskReports, plan, confidence, meta);
        const dashboardPath = reportingEngine.generateDashboard({
            meta,
            graph: { nodes: headGraph.getNodes(), edges: headGraph.getEdges() },
            diff: diffReport,
            risks: riskReports,
            plan,
            confidence
        });

        console.log(`\nDiff Mode: ${diffMode}`);
        console.log(`Reports generated:`);
        console.log(`- Markdown: ${mdPath}`);
        console.log(`- Interactive dashboard: ${dashboardPath}`);

        // Exit non-zero if confidence below threshold (CI gating hook)
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
