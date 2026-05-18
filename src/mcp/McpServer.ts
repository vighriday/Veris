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
import { BehavioralGraph } from '../models/GraphModels';
import * as path from 'path';

export class VerisMcpServer {
    private server: Server;
    private projectRoot: string;

    // Singleton-like state for this MCP session
    private lastReport: any;
    private currentGraph: BehavioralGraph | null = null;
    private lastRiskReports: any[] = [];
    private lastPlan: any = null;

    constructor() {
        this.server = new Server(
            {
                name: "veris-mcp-server",
                version: "1.0.0",
            },
            {
                capabilities: {
                    tools: {},
                },
            }
        );

        this.projectRoot = path.resolve(process.cwd());
        this.setupToolHandlers();
        
        // Error handling
        this.server.onerror = (error) => console.error('[MCP Error]', error);
    }

    private setupToolHandlers() {
        this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: [
                {
                    name: "analyze_repository",
                    description: "Analyzes the repository AST to return semantic domains, entities, and dependency relationships.",
                    inputSchema: { type: "object", properties: {}, required: [] }
                },
                {
                    name: "export_behavioral_graph",
                    description: "Returns the behavioral graph representation, workflow relationships, and dependency topology.",
                    inputSchema: { type: "object", properties: {}, required: [] }
                },
                {
                    name: "analyze_pr_behavior",
                    description: "Computes a semantic diff between git refs (real diff via worktree) and returns impacted workflows and risk scores. Falls back to synthetic diff if not a git repo.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            baseRef: { type: "string", description: "Optional git base ref. Defaults: origin/main, main, HEAD~1." }
                        },
                        required: []
                    }
                },
                {
                    name: "generate_verification_plan",
                    description: "Generates validation targets and priority execution recommendations based on active risk profiles.",
                    inputSchema: { type: "object", properties: {}, required: [] }
                },
                {
                    name: "identify_unverified_behaviors",
                    description: "Returns missing coverage, runtime blind spots, and overall confidence considering executed verifications.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            executedTargetsCount: { type: "number", description: "Number of successfully executed verification targets" }
                        },
                        required: ["executedTargetsCount"]
                    }
                }
            ]
        }));

        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            switch (request.params.name) {
                case "analyze_repository": {
                    const engine = new RepositoryIntelligenceEngine(this.projectRoot);
                    this.lastReport = engine.analyze();
                    return { content: [{ type: "text", text: `Repository analyzed. Found ${this.lastReport.files.length} files.` }] };
                }

                case "export_behavioral_graph": {
                    if (!this.lastReport) {
                        const engine = new RepositoryIntelligenceEngine(this.projectRoot);
                        this.lastReport = engine.analyze();
                    }
                    const graphEngine = new BehavioralGraphEngine();
                    this.currentGraph = graphEngine.buildGraphFromReport(this.lastReport);
                    return {
                        content: [{ 
                            type: "text", 
                            text: JSON.stringify({
                                nodesCount: this.currentGraph.getNodes().length,
                                edgesCount: this.currentGraph.getEdges().length,
                                sampleNodes: this.currentGraph.getNodes().slice(0, 5)
                            }, null, 2)
                        }]
                    };
                }

                case "analyze_pr_behavior": {
                    const args = (request.params.arguments || {}) as any;
                    const baseRefHint: string | undefined = args.baseRef;

                    const driver = new GitDiffDriver(this.projectRoot);
                    const snap = driver.snapshot(baseRefHint);

                    let oldGraph: BehavioralGraph;
                    let newGraph: BehavioralGraph;
                    let mode = 'git';
                    let refs: any = {};

                    if (snap) {
                        oldGraph = snap.baseGraph;
                        newGraph = snap.headGraph;
                        this.currentGraph = newGraph;
                        refs = { baseRef: snap.baseRef, headRef: snap.headRef };
                    } else {
                        if (!this.currentGraph) {
                            const engine = new RepositoryIntelligenceEngine(this.projectRoot);
                            this.lastReport = engine.analyze();
                            const ge = new BehavioralGraphEngine();
                            this.currentGraph = ge.buildGraphFromReport(this.lastReport);
                        }
                        oldGraph = new BehavioralGraph();
                        this.currentGraph.getNodes().slice(0, Math.floor(this.currentGraph.getNodes().length * 0.7)).forEach(n => oldGraph.addNode(n));
                        this.currentGraph.getEdges().slice(0, Math.floor(this.currentGraph.getEdges().length * 0.7)).forEach(e => oldGraph.addEdge(e));
                        newGraph = this.currentGraph;
                        mode = 'synthetic';
                    }

                    const diffEngine = new BehavioralDiffEngine();
                    const diffReport = diffEngine.computeDiff(oldGraph, newGraph);
                    const riskEngine = new RiskModelingEngine();
                    this.lastRiskReports = riskEngine.assessRisk(diffReport, newGraph);

                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify({
                                diffMode: mode,
                                ...refs,
                                addedNodes: diffReport.addedNodes.length,
                                removedNodes: diffReport.removedNodes.length,
                                impactedNodes: diffReport.impactedNodes.length,
                                riskReports: this.lastRiskReports.slice(0, 3)
                            }, null, 2)
                        }]
                    };
                }

                case "generate_verification_plan": {
                    if (!this.lastRiskReports || this.lastRiskReports.length === 0) {
                        throw new Error("No risk reports available. Run analyze_pr_behavior first.");
                    }
                    const planner = new VerificationPlanningEngine();
                    this.lastPlan = planner.generatePlan(this.lastRiskReports);
                    return {
                        content: [{ type: "text", text: JSON.stringify(this.lastPlan, null, 2) }]
                    };
                }

                case "identify_unverified_behaviors": {
                    if (!this.lastPlan) {
                        throw new Error("No verification plan active. Run generate_verification_plan first.");
                    }
                    const { executedTargetsCount } = request.params.arguments as any;
                    const confidenceEngine = new ConfidenceEngine();
                    const confidence = confidenceEngine.calculateConfidence(this.lastRiskReports, this.lastPlan, executedTargetsCount || 0);

                    return {
                        content: [{ type: "text", text: JSON.stringify(confidence, null, 2) }]
                    };
                }

                default:
                    throw new Error("Unknown tool");
            }
        });
    }

    async run() {
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        console.error("Veris MCP Server running on stdio");
    }
}
