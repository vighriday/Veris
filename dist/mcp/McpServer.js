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
exports.BviMcpServer = void 0;
const index_js_1 = require("@modelcontextprotocol/sdk/server/index.js");
const stdio_js_1 = require("@modelcontextprotocol/sdk/server/stdio.js");
const types_js_1 = require("@modelcontextprotocol/sdk/types.js");
const RepositoryIntelligenceEngine_1 = require("../engine/RepositoryIntelligenceEngine");
const BehavioralGraphEngine_1 = require("../engine/BehavioralGraphEngine");
const BehavioralDiffEngine_1 = require("../engine/BehavioralDiffEngine");
const RiskModelingEngine_1 = require("../engine/RiskModelingEngine");
const VerificationPlanningEngine_1 = require("../engine/VerificationPlanningEngine");
const ConfidenceEngine_1 = require("../engine/ConfidenceEngine");
const GraphModels_1 = require("../models/GraphModels");
const path = __importStar(require("path"));
class BviMcpServer {
    server;
    projectRoot;
    // Singleton-like state for this MCP session
    lastReport;
    currentGraph = null;
    lastRiskReports = [];
    lastPlan = null;
    constructor() {
        this.server = new index_js_1.Server({
            name: "bvi-mcp-server",
            version: "1.0.0",
        }, {
            capabilities: {
                tools: {},
            },
        });
        this.projectRoot = path.resolve(process.cwd());
        this.setupToolHandlers();
        // Error handling
        this.server.onerror = (error) => console.error('[MCP Error]', error);
    }
    setupToolHandlers() {
        this.server.setRequestHandler(types_js_1.ListToolsRequestSchema, async () => ({
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
        this.server.setRequestHandler(types_js_1.CallToolRequestSchema, async (request) => {
            switch (request.params.name) {
                case "analyze_repository": {
                    const engine = new RepositoryIntelligenceEngine_1.RepositoryIntelligenceEngine(this.projectRoot);
                    this.lastReport = engine.analyze();
                    return { content: [{ type: "text", text: `Repository analyzed. Found ${this.lastReport.files.length} files.` }] };
                }
                case "export_behavioral_graph": {
                    if (!this.lastReport) {
                        const engine = new RepositoryIntelligenceEngine_1.RepositoryIntelligenceEngine(this.projectRoot);
                        this.lastReport = engine.analyze();
                    }
                    const graphEngine = new BehavioralGraphEngine_1.BehavioralGraphEngine();
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
                    const oldGraph = new GraphModels_1.BehavioralGraph();
                    this.currentGraph.getNodes().slice(0, Math.floor(this.currentGraph.getNodes().length * 0.7)).forEach(n => oldGraph.addNode(n));
                    this.currentGraph.getEdges().slice(0, Math.floor(this.currentGraph.getEdges().length * 0.7)).forEach(e => oldGraph.addEdge(e));
                    const diffEngine = new BehavioralDiffEngine_1.BehavioralDiffEngine();
                    const diffReport = diffEngine.computeDiff(oldGraph, this.currentGraph);
                    const riskEngine = new RiskModelingEngine_1.RiskModelingEngine();
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
                    const planner = new VerificationPlanningEngine_1.VerificationPlanningEngine();
                    this.lastPlan = planner.generatePlan(this.lastRiskReports);
                    return {
                        content: [{ type: "text", text: JSON.stringify(this.lastPlan, null, 2) }]
                    };
                }
                case "identify_unverified_behaviors": {
                    if (!this.lastPlan) {
                        throw new Error("No verification plan active. Run generate_verification_plan first.");
                    }
                    const { executedTargetsCount } = request.params.arguments;
                    const confidenceEngine = new ConfidenceEngine_1.ConfidenceEngine();
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
        const transport = new stdio_js_1.StdioServerTransport();
        await this.server.connect(transport);
        console.error("BVI MCP Server running on stdio");
    }
}
exports.BviMcpServer = BviMcpServer;
