import { RepositoryIntelligenceEngine } from './engine/RepositoryIntelligenceEngine';
import { BehavioralGraphEngine } from './engine/BehavioralGraphEngine';
import { BehavioralDiffEngine } from './engine/BehavioralDiffEngine';
import { RiskModelingEngine } from './engine/RiskModelingEngine';
import { VerificationPlanningEngine } from './engine/VerificationPlanningEngine';
import { ConfidenceEngine } from './engine/ConfidenceEngine';
import { ReportingEngine } from './reporting/ReportingEngine';
import { BehavioralGraph, NodeType, EdgeType } from './models/GraphModels';
import * as path from 'path';

async function main() {
    console.log("==================================================");
    console.log("Veris Phase 1: Repository Intelligence Engine");
    console.log("==================================================\n");

    const projectRoot = path.resolve(__dirname, '../');
    const engine = new RepositoryIntelligenceEngine(projectRoot);
    
    console.log(`Analyzing Repository: ${projectRoot}`);
    const report = engine.analyze();
    
    console.log(`Number of files analyzed: ${report.files.length}\n`);

    console.log("==================================================");
    console.log("Veris Phase 2: Semantic Understanding & Graph");
    console.log("==================================================\n");

    const graphEngine = new BehavioralGraphEngine();
    const currentGraph = graphEngine.buildGraphFromReport(report);
    
    console.log(`Graph Nodes Extracted: ${currentGraph.getNodes().length}`);
    console.log(`Graph Edges Extracted: ${currentGraph.getEdges().length}\n`);

    // Simulate an older state by creating a smaller graph (mocking a diff)
    const oldGraph = new BehavioralGraph();
    // Only copy 70% of nodes and edges to simulate that new codebase added things
    currentGraph.getNodes().slice(0, Math.floor(currentGraph.getNodes().length * 0.7)).forEach(n => oldGraph.addNode(n));
    currentGraph.getEdges().slice(0, Math.floor(currentGraph.getEdges().length * 0.7)).forEach(e => oldGraph.addEdge(e));

    console.log("==================================================");
    console.log("Veris Phase 3: Behavioral Diff & Risk Modeling");
    console.log("==================================================\n");

    const diffEngine = new BehavioralDiffEngine();
    const diffReport = diffEngine.computeDiff(oldGraph, currentGraph);

    console.log(`Semantic Diff Findings:`);
    console.log(`  Added Nodes: ${diffReport.addedNodes.length}`);
    console.log(`  Added Edges: ${diffReport.addedEdges.length}`);
    console.log(`  Impacted Nodes for Risk Analysis: ${diffReport.impactedNodes.length}\n`);

    const riskEngine = new RiskModelingEngine();
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
    console.log("Veris Phase 4: Verification Planning & Confidence Engine");
    console.log("==================================================\n");

    const verificationPlanner = new VerificationPlanningEngine();
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

    const confidenceEngine = new ConfidenceEngine();
    // Simulate executing 30% of the verification plan
    const simulatedExecutedTargets = Math.max(1, Math.floor(plan.targets.length * 0.3));
    const confidence = confidenceEngine.calculateConfidence(riskReports, plan, simulatedExecutedTargets);

    console.log(`\nConfidence Assessment:`);
    console.log(`  Extrapolated Execution Depth: ${confidence.executionDepth}%`);
    console.log(`  Overall Veris Confidence Score: ${confidence.overallConfidence}/100\n`);
    console.log(`  Confidence Explainability:`);
    confidence.explanation.forEach(exp => console.log(`    - ${exp}`));
    if (confidence.unverifiedAssumptions.length > 0) {
        console.log(`  Unverified Assumptions (Risks remain):`);
        confidence.unverifiedAssumptions.forEach(assump => console.log(`    - ${assump}`));
    }

    console.log("==================================================");
    console.log("Veris Phase 6: Reporting and Dashboard");
    console.log("==================================================\n");

    const reportingEngine = new ReportingEngine(projectRoot);
    const meta = { diffMode: 'synthetic', projectRoot, generatedAt: new Date().toISOString() };
    const mdPath = reportingEngine.generateMarkdownReport(diffReport, riskReports, plan, confidence, meta);
    console.log(`Markdown Report generated at: ${mdPath}`);

    const dashboardPath = reportingEngine.generateDashboard({
        meta,
        graph: { nodes: currentGraph.getNodes(), edges: currentGraph.getEdges() },
        diff: diffReport,
        risks: riskReports,
        plan,
        confidence
    });
    console.log(`Interactive Dashboard generated at: ${dashboardPath}`);

    console.log("\nEnd of Veris Pipeline run.");}

main().catch(err => {
    console.error("Failed to run Repository Intelligence Engine", err);
});
