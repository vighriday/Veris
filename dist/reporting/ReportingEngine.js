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
exports.ReportingEngine = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
class ReportingEngine {
    outputDir;
    constructor(projectRoot) {
        this.outputDir = path.join(projectRoot, 'bvi-reports');
        if (!fs.existsSync(this.outputDir)) {
            fs.mkdirSync(this.outputDir, { recursive: true });
        }
    }
    generateMarkdownReport(diff, risks, plan, confidence) {
        let md = `# BVI Executive Summary\n\n`;
        md += `## 1. Repository Health & Confidence\n`;
        md += `- **Overall Confidence Score:** ${confidence.overallConfidence}/100\n`;
        md += `- **Execution Depth:** ${confidence.executionDepth}%\n\n`;
        if (confidence.explanation.length > 0) {
            md += `### Confidence Explainability\n`;
            confidence.explanation.forEach(e => md += `- ${e}\n`);
            md += `\n`;
        }
        if (confidence.unverifiedAssumptions.length > 0) {
            md += `### Unverified Assumptions (Runtime Risks)\n`;
            confidence.unverifiedAssumptions.forEach(u => md += `- ${u}\n`);
            md += `\n`;
        }
        md += `## 2. Behavioral Diff & Workflow Risk Map\n`;
        md += `- **Added Nodes:** ${diff.addedNodes.length}\n`;
        md += `- **Added Edges:** ${diff.addedEdges.length}\n`;
        md += `- **Impacted Workflows/Nodes:** ${diff.impactedNodes.length}\n\n`;
        if (risks.length > 0) {
            md += `### Top Risk Factors\n`;
            // Sort by risk descending
            const sortedRisks = [...risks].sort((a, b) => b.score.overallRisk - a.score.overallRisk).slice(0, 5);
            sortedRisks.forEach(r => {
                md += `#### Node: \`${r.nodeId}\`\n`;
                md += `- **Risk Score:** ${r.score.overallRisk.toFixed(2)} (Blast Radius: ${r.score.blastRadius}, Fragility: ${r.score.dependencyFragility})\n`;
                r.score.explanation.forEach(exp => md += `  - ${exp}\n`);
            });
            md += `\n`;
        }
        md += `## 3. Verification Coverage & Directives\n`;
        md += `- **Total Verification Targets:** ${plan.targets.length}\n\n`;
        md += `### Execution Recommendations\n`;
        plan.executionRecommendations.forEach(rec => md += `- ${rec}\n`);
        md += `\n`;
        const mdPath = path.join(this.outputDir, 'bvi-report.md');
        fs.writeFileSync(mdPath, md, 'utf8');
        return mdPath;
    }
    generateHtmlReport(mdContent) {
        // A very basic HTML generator mapping the MD logic for dashboarding purposes
        const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>BVI Dashboard</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; padding: 20px; max-width: 900px; margin: auto; background-color: #f9f9f9; color: #333; }
        .card { background: #fff; padding: 20px; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); margin-bottom: 20px; }
        h1, h2, h3 { color: #111; }
        ul { margin-top: 0; }
        .danger { color: #d9534f; font-weight: bold; }
        .warning { color: #f0ad4e; }
        .success { color: #5cb85c; }
    </style>
</head>
<body>
    <h1>BVI Interactive Dashboard</h1>
    <div class="card">
        ${mdContent.replace(/## (.*)/g, '<h2>$1</h2>').replace(/### (.*)/g, '<h3>$1</h3>').replace(/#### (.*)/g, '<h4>$1</h4>').replace(/- (.*)/g, '<li>$1</li>').replace(/\n\n/g, '</ul><ul>').replace(/<\/ul><ul>/, '<ul>')}
    </div>
    <script>
        // Placeholder for future interactive visualization layers (e.g. Graph diagrams via library)
        console.log("BVI Dashboard Loaded");
    </script>
</body>
</html>`;
        const htmlPath = path.join(this.outputDir, 'bvi-dashboard.html');
        // Clean up some markdown artifacts from regex
        const cleanedHtml = html.replace(/<ul>\s*<\/ul>/g, '');
        fs.writeFileSync(htmlPath, cleanedHtml, 'utf8');
        return htmlPath;
    }
}
exports.ReportingEngine = ReportingEngine;
