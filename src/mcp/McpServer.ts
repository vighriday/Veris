import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { RepositoryIntelligenceEngine } from '../engine/RepositoryIntelligenceEngine';
import { BehavioralGraphEngine } from '../engine/BehavioralGraphEngine';
import { BehavioralDiffEngine } from '../engine/BehavioralDiffEngine';
import { RiskModelingEngine } from '../engine/RiskModelingEngine';
import { VerificationPlanningEngine } from '../engine/VerificationPlanningEngine';
import { ConfidenceEngine } from '../engine/ConfidenceEngine';
import { BehavioralGraph } from '../models/GraphModels';
import * as path from 'path';

export class BviMcpServer {
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
                name: "bvi-mcp-server",
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
                    description: "Computes a semantic diff between states and returns impacted workflows and risk scores.",
                    inputSchema: { type: "object", properties: {}, required: [] }
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
                    if (!this.currentGraph) {
                        throw new Error("Graph not exported yet. Run export_behavioral_graph first.");
                    }
                    // Simulating an AI generated PR / older state diff dynamically
                    const oldGraph = new BehavioralGraph();
                    this.currentGraph.getNodes().slice(0, Math.floor(this.currentGraph.getNodes().length * 0.7)).forEach(n => oldGraph.addNode(n));
                    this.currentGraph.getEdges().slice(0, Math.floor(this.currentGraph.getEdges().length * 0.7)).forEach(e => oldGraph.addEdge(e));

                    const diffEngine = new BehavioralDiffEngine();
                    const diffReport = diffEngine.computeDiff(oldGraph, this.currentGraph);
                    const riskEngine = new RiskModelingEngine();
                    
                    this.lastRiskReports = riskEngine.assessRisk(diffReport, this.currentGraph);
                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify({
                                impactedNodes: diffReport.impactedNodes.length,
                                riskReports: this.lastRiskReports.slice(0, 3) // Return top 3 for brevity
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
        console.error("BVI MCP Server running on stdio");
    }
}
