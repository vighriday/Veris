#!/usr/bin/env node
"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const path = __importStar(require("path"));
const RepositoryIntelligenceEngine_1 = require("./engine/RepositoryIntelligenceEngine");
const BehavioralGraphEngine_1 = require("./engine/BehavioralGraphEngine");
const BehavioralDiffEngine_1 = require("./engine/BehavioralDiffEngine");
const RiskModelingEngine_1 = require("./engine/RiskModelingEngine");
const VerificationPlanningEngine_1 = require("./engine/VerificationPlanningEngine");
const ConfidenceEngine_1 = require("./engine/ConfidenceEngine");
const ReportingEngine_1 = require("./reporting/ReportingEngine");
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
        const intelEngine = new RepositoryIntelligenceEngine_1.RepositoryIntelligenceEngine(targetDir);
        const report = intelEngine.analyze();
        // Phase 2
        console.log("-> Generating Behavioral Graph...");
        const graphEngine = new BehavioralGraphEngine_1.BehavioralGraphEngine();
        const baseGraph = graphEngine.buildGraphFromReport(report);
        // Phase 3
        console.log("-> Calculating Risk Models...");
        const diffEngine = new BehavioralDiffEngine_1.BehavioralDiffEngine();
        // Simulating a diff by using the same graph for PoC
        const diffReport = diffEngine.computeDiff(baseGraph, baseGraph);
        const riskEngine = new RiskModelingEngine_1.RiskModelingEngine();
        const riskReports = riskEngine.assessRisk(diffReport, baseGraph);
        // Phase 4 & 5
        console.log("-> Planning Verification...");
        const planningEngine = new VerificationPlanningEngine_1.VerificationPlanningEngine();
        const plan = planningEngine.generatePlan(riskReports);
        console.log("-> Assessing Confidence...");
        const confidenceEngine = new ConfidenceEngine_1.ConfidenceEngine();
        // Simulating that nothing has been executed yet
        const confidence = confidenceEngine.calculateConfidence(riskReports, plan, 0);
        // Phase 6
        console.log("-> Generating Reports...");
        const reportingEngine = new ReportingEngine_1.ReportingEngine(targetDir);
        const mdPath = reportingEngine.generateMarkdownReport(diffReport, riskReports, plan, confidence);
        const fs = require('fs');
        const mdContent = fs.readFileSync(mdPath, 'utf8');
        const htmlPath = reportingEngine.generateHtmlReport(mdContent);
        console.log(`\nSuccess! Reports generated at:`);
        console.log(`- ${mdPath}`);
        console.log(`- ${htmlPath}`);
    }
    catch (e) {
        console.error("BVI CLI Error:", e);
        process.exit(1);
    }
}
runCli();
