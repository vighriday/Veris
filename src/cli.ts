#!/usr/bin/env node
import * as path from 'path';
import { RepositoryIntelligenceEngine } from './engine/RepositoryIntelligenceEngine';
import { BehavioralGraphEngine } from './engine/BehavioralGraphEngine';
import { BehavioralDiffEngine } from './engine/BehavioralDiffEngine';
import { RiskModelingEngine } from './engine/RiskModelingEngine';
import { VerificationPlanningEngine } from './engine/VerificationPlanningEngine';
import { ConfidenceEngine } from './engine/ConfidenceEngine';
import { ReportingEngine } from './reporting/ReportingEngine';

async function runCli() {
    console.log("==================================================");
    console.log("BVI CLI - Behavioral Verification Infrastructure");
    console.log("==================================================");

    const args = process.argv.slice(2);
    const targetDir = args[0] ? path.resolve(args[0]) : process.cwd();

    console.log(`Target Directory: ${targetDir}\n`);

    try {
        // Phase 1
        console.log("-> Running Intelligence Engine...");
        const intelEngine = new RepositoryIntelligenceEngine(targetDir);
        const report = intelEngine.analyze();

        // Phase 2
        console.log("-> Generating Behavioral Graph...");
        const graphEngine = new BehavioralGraphEngine();
        const baseGraph = graphEngine.buildGraphFromReport(report);

        // Phase 3
        console.log("-> Calculating Risk Models...");
        const diffEngine = new BehavioralDiffEngine();
        // Simulating a diff by using the same graph for PoC
        const diffReport = diffEngine.computeDiff(baseGraph, baseGraph);
        const riskEngine = new RiskModelingEngine();
        const riskReports = riskEngine.assessRisk(diffReport, baseGraph);

        // Phase 4 & 5
        console.log("-> Planning Verification...");
        const planningEngine = new VerificationPlanningEngine();
        const plan = planningEngine.generatePlan(riskReports);

        console.log("-> Assessing Confidence...");
        const confidenceEngine = new ConfidenceEngine();
        // Simulating that nothing has been executed yet
        const confidence = confidenceEngine.calculateConfidence(riskReports, plan, 0);

        // Phase 6
        console.log("-> Generating Reports...");
        const reportingEngine = new ReportingEngine(targetDir);
        const mdPath = reportingEngine.generateMarkdownReport(diffReport, riskReports, plan, confidence);
        
        const fs = require('fs');
        const mdContent = fs.readFileSync(mdPath, 'utf8');
        const htmlPath = reportingEngine.generateHtmlReport(mdContent);

        console.log(`\nSuccess! Reports generated at:`);
        console.log(`- ${mdPath}`);
        console.log(`- ${htmlPath}`);
        
    } catch (e) {
        console.error("BVI CLI Error:", e);
        process.exit(1);
    }
}

runCli();
