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
const RepositoryIntelligenceEngine_1 = require("./engine/RepositoryIntelligenceEngine");
const BehavioralGraphEngine_1 = require("./engine/BehavioralGraphEngine");
const BehavioralDiffEngine_1 = require("./engine/BehavioralDiffEngine");
const RiskModelingEngine_1 = require("./engine/RiskModelingEngine");
const VerificationPlanningEngine_1 = require("./engine/VerificationPlanningEngine");
const ConfidenceEngine_1 = require("./engine/ConfidenceEngine");
const ReportingEngine_1 = require("./reporting/ReportingEngine");
const GraphModels_1 = require("./models/GraphModels");
const path = __importStar(require("path"));
async function main() {
    console.log("==================================================");
    console.log("BVI Phase 1: Repository Intelligence Engine");
    console.log("==================================================\n");
    const projectRoot = path.resolve(__dirname, '../');
    const engine = new RepositoryIntelligenceEngine_1.RepositoryIntelligenceEngine(projectRoot);
    console.log(`Analyzing Repository: ${projectRoot}`);
    const report = engine.analyze();
    console.log(`Number of files analyzed: ${report.files.length}\n`);
    console.log("==================================================");
    console.log("BVI Phase 2: Semantic Understanding & Graph");
    console.log("==================================================\n");
    const graphEngine = new BehavioralGraphEngine_1.BehavioralGraphEngine();
    const currentGraph = graphEngine.buildGraphFromReport(report);
    console.log(`Graph Nodes Extracted: ${currentGraph.getNodes().length}`);
    console.log(`Graph Edges Extracted: ${currentGraph.getEdges().length}\n`);
    // Simulate an older state by creating a smaller graph (mocking a diff)
    const oldGraph = new GraphModels_1.BehavioralGraph();
    // Only copy 70% of nodes and edges to simulate that new codebase added things
    currentGraph.getNodes().slice(0, Math.floor(currentGraph.getNodes().length * 0.7)).forEach(n => oldGraph.addNode(n));
    currentGraph.getEdges().slice(0, Math.floor(currentGraph.getEdges().length * 0.7)).forEach(e => oldGraph.addEdge(e));
    console.log("==================================================");
    console.log("BVI Phase 3: Behavioral Diff & Risk Modeling");
    console.log("==================================================\n");
    const diffEngine = new BehavioralDiffEngine_1.BehavioralDiffEngine();
    const diffReport = diffEngine.computeDiff(oldGraph, currentGraph);
    console.log(`Semantic Diff Findings:`);
    console.log(`  Added Nodes: ${diffReport.addedNodes.length}`);
    console.log(`  Added Edges: ${diffReport.addedEdges.length}`);
    console.log(`  Impacted Nodes for Risk Analysis: ${diffReport.impactedNodes.length}\n`);
    const riskEngine = new RiskModelingEngine_1.RiskModelingEngine();
    const riskReports = riskEngine.assessRisk(diffReport, currentGraph);
    // Limit printing risk to first 2 to save console space
    riskReports.slice(0, 2).forEach(r => {
        console.log(`[RISK] Node: ${r.nodeId}`);
        console.log(`  Overall Risk Score: ${r.score.overallRisk}/100`);
        console.log(`  Explainability:`);
        r.score.explanation.forEach(exp => console.log(`    - ${exp}`));
        console.log(`---`);
    });
    console.log("==================================================");
    console.log("BVI Phase 4: Verification Planning & Confidence Engine");
    console.log("==================================================\n");
    const verificationPlanner = new VerificationPlanningEngine_1.VerificationPlanningEngine();
    const plan = verificationPlanner.generatePlan(riskReports);
    console.log(`Generated Verification Plan:`);
    console.log(`  Total Verification Targets: ${plan.targets.length}`);
    console.log(`  Execution Recommendations:`);
    plan.executionRecommendations.forEach(rec => console.log(`    - ${rec}`));
    console.log(`\nSample Target [High Priority]:`);
    const highPri = plan.targets.find(t => t.priority === 'High');
    if (highPri) {
        console.log(`    Node: ${highPri.nodeId}`);
        console.log(`    Tier: ${highPri.tier}`);
        console.log(`    Directive: ${highPri.directive}`);
    }
    const confidenceEngine = new ConfidenceEngine_1.ConfidenceEngine();
    // Simulate executing 30% of the verification plan
    const simulatedExecutedTargets = Math.max(1, Math.floor(plan.targets.length * 0.3));
    const confidence = confidenceEngine.calculateConfidence(riskReports, plan, simulatedExecutedTargets);
    console.log(`\nConfidence Assessment:`);
    console.log(`  Extrapolated Execution Depth: ${confidence.executionDepth}%`);
    console.log(`  Overall BVI Confidence Score: ${confidence.overallConfidence}/100\n`);
    console.log(`  Confidence Explainability:`);
    confidence.explanation.forEach(exp => console.log(`    - ${exp}`));
    if (confidence.unverifiedAssumptions.length > 0) {
        console.log(`  Unverified Assumptions (Risks remain):`);
        confidence.unverifiedAssumptions.forEach(assump => console.log(`    - ${assump}`));
    }
    console.log("==================================================");
    console.log("BVI Phase 6: Reporting and Dashboard");
    console.log("==================================================\n");
    const reportingEngine = new ReportingEngine_1.ReportingEngine(projectRoot);
    const mdPath = reportingEngine.generateMarkdownReport(diffReport, riskReports, plan, confidence);
    console.log(`Markdown Report generated at: ${mdPath}`);
    // Read the MD to convert to HTML
    const fs = require('fs');
    const mdContent = fs.readFileSync(mdPath, 'utf8');
    const htmlPath = reportingEngine.generateHtmlReport(mdContent);
    console.log(`HTML Dashboard generated at: ${htmlPath}`);
    console.log("\nEnd of BVI Pipeline run.");
}
main().catch(err => {
    console.error("Failed to run Repository Intelligence Engine", err);
});
