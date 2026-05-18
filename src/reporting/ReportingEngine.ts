import * as fs from 'fs';
import * as path from 'path';
import { RiskReport, DiffReport } from '../models/RiskModels';
import { VerificationPlan, ConfidenceReport, VerificationTarget } from '../models/VerificationModels';
import { BehavioralGraph, GraphNode, GraphEdge, NodeType, EdgeType } from '../models/GraphModels';
import { WorkflowReport } from '../models/WorkflowModels';
import { DriftReport } from '../engine/DriftDetector';
import { WorkflowFingerprint } from '../engine/WorkflowFingerprint';
import { AdversarialProbe } from '../engine/AdversarialProbeGenerator';
import { BudgetAllocation } from '../engine/VerificationBudgetAllocator';
import { ConfidenceTrendRow } from '../persistence/VerisState';

export interface ReportMeta {
    diffMode?: 'git' | 'synthetic' | string;
    baseRef?: string;
    headRef?: string;
    projectRoot?: string;
    generatedAt?: string;
}

export interface DashboardPayload {
    meta: ReportMeta;
    graph: { nodes: GraphNode[]; edges: GraphEdge[] };
    diff: DiffReport;
    risks: RiskReport[];
    plan: VerificationPlan;
    confidence: ConfidenceReport;
    workflows?: WorkflowReport;
    drift?: DriftReport;
    fingerprints?: WorkflowFingerprint[];
    probes?: AdversarialProbe[];
    budget?: BudgetAllocation;
    confidenceTrend?: ConfidenceTrendRow[];
    pluginsLoaded?: string[];
    runId?: string;
}

export class ReportingEngine {

    private outputDir: string;

    constructor(projectRoot: string) {
        this.outputDir = path.join(projectRoot, 'veris-reports');
        if (!fs.existsSync(this.outputDir)) {
            fs.mkdirSync(this.outputDir, { recursive: true });
        }
    }

    public generateMarkdownReport(
        diff: DiffReport,
        risks: RiskReport[],
        plan: VerificationPlan,
        confidence: ConfidenceReport,
        meta: ReportMeta = {}
    ): string {
        let md = `# Veris Executive Summary\n\n`;

        if (meta.diffMode) {
            md += `_Diff mode: **${meta.diffMode}**`;
            if (meta.baseRef && meta.headRef) md += ` (${meta.baseRef} -> ${meta.headRef})`;
            md += `_\n\n`;
        }

        md += `## 1. Repository Health & Confidence\n\n`;
        md += `- **Overall Confidence Score:** ${confidence.overallConfidence}/100\n`;
        md += `- **Execution Depth:** ${confidence.executionDepth}%\n\n`;

        if (confidence.explanation.length > 0) {
            md += `### Confidence Explainability\n\n`;
            confidence.explanation.forEach(e => md += `- ${e}\n`);
            md += `\n`;
        }

        if (confidence.unverifiedAssumptions.length > 0) {
            md += `### Unverified Assumptions (Runtime Risks)\n\n`;
            confidence.unverifiedAssumptions.forEach(u => md += `- ${u}\n`);
            md += `\n`;
        }

        md += `## 2. Behavioral Diff & Workflow Risk Map\n\n`;
        md += `- **Added Nodes:** ${diff.addedNodes.length}\n`;
        md += `- **Removed Nodes:** ${diff.removedNodes.length}\n`;
        md += `- **Added Edges:** ${diff.addedEdges.length}\n`;
        md += `- **Removed Edges:** ${diff.removedEdges.length}\n`;
        md += `- **Impacted Workflows/Nodes:** ${diff.impactedNodes.length}\n\n`;

        if (risks.length > 0) {
            md += `### Top Risk Factors\n\n`;
            const sortedRisks = [...risks].sort((a, b) => b.score.overallRisk - a.score.overallRisk).slice(0, 5);
            sortedRisks.forEach(r => {
                md += `#### Node: \`${r.nodeId}\`\n\n`;
                md += `- **Risk Score:** ${r.score.overallRisk.toFixed(2)} (Blast Radius: ${r.score.blastRadius}, Fragility: ${r.score.dependencyFragility})\n`;
                r.score.explanation.forEach(exp => md += `- ${exp}\n`);
                md += `\n`;
            });
        }

        md += `## 3. Verification Coverage & Directives\n\n`;
        md += `- **Total Verification Targets:** ${plan.targets.length}\n\n`;
        md += `### Execution Recommendations\n\n`;
        plan.executionRecommendations.forEach(rec => md += `- ${rec}\n`);
        md += `\n`;

        const mdPath = path.join(this.outputDir, 'veris-report.md');
        fs.writeFileSync(mdPath, md, 'utf8');
        return mdPath;
    }

    /**
     * Generates a single-file interactive HTML dashboard.
     * Embeds the full payload as JSON. Uses vis-network CDN for the graph viz.
     * Sections: Confidence gauge, Diff summary, Workflow Risk Map (interactive graph),
     * Risk cards (sortable), Verification targets (filterable + click-to-copy directives),
     * Unverified assumptions, Coverage breakdown.
     */
    public generateDashboard(payload: DashboardPayload): string {
        const htmlPath = path.join(this.outputDir, 'veris-dashboard.html');
        const html = renderDashboard(payload);
        fs.writeFileSync(htmlPath, html, 'utf8');
        return htmlPath;
    }

    /**
     * Kept for backwards compatibility. Re-uses old markdown -> HTML for simple consumers.
     */
    public generateHtmlReport(mdContent: string): string {
        const body = this.renderMarkdown(mdContent);
        const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Veris Report</title>
<style>body{font-family:-apple-system,sans-serif;max-width:900px;margin:auto;padding:20px;line-height:1.6;}</style>
</head><body>${body}</body></html>`;
        const htmlPath = path.join(this.outputDir, 'veris-report.html');
        fs.writeFileSync(htmlPath, html, 'utf8');
        return htmlPath;
    }

    private renderMarkdown(md: string): string {
        const lines = md.split(/\r?\n/);
        const out: string[] = [];
        let inList = false;
        const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };
        const inline = (s: string) => s
            .replace(/`([^`]+)`/g, '<code>$1</code>')
            .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
            .replace(/_([^_]+)_/g, '<em>$1</em>');

        for (const raw of lines) {
            const line = raw.trimEnd();
            if (/^####\s+/.test(line)) { closeList(); out.push(`<h4>${inline(line.replace(/^####\s+/, ''))}</h4>`); continue; }
            if (/^###\s+/.test(line))  { closeList(); out.push(`<h3>${inline(line.replace(/^###\s+/, ''))}</h3>`); continue; }
            if (/^##\s+/.test(line))   { closeList(); out.push(`<h2>${inline(line.replace(/^##\s+/, ''))}</h2>`); continue; }
            if (/^#\s+/.test(line))    { closeList(); out.push(`<h1>${inline(line.replace(/^#\s+/, ''))}</h1>`); continue; }
            if (/^-\s+/.test(line))    {
                if (!inList) { out.push('<ul>'); inList = true; }
                out.push(`<li>${inline(line.replace(/^-\s+/, ''))}</li>`);
                continue;
            }
            if (line.trim() === '') { closeList(); continue; }
            closeList();
            out.push(`<p>${inline(line)}</p>`);
        }
        closeList();
        return out.join('\n');
    }
}

function renderDashboard(payload: DashboardPayload): string {
    const json = JSON.stringify(payload, (_k, v) => {
        // Trim verbose fields to keep file size reasonable
        return v;
    });

    // Pre-compute summary stats
    const totalNodes = payload.graph.nodes.length;
    const totalEdges = payload.graph.edges.length;
    const totalRisks = payload.risks.length;
    const highRiskCount = payload.risks.filter(r => r.score.overallRisk >= 50).length;
    const targetsByTier = {
        structural: payload.plan.targets.filter(t => t.tier.startsWith('Tier 1')).length,
        behavioral: payload.plan.targets.filter(t => t.tier.startsWith('Tier 2')).length,
        adversarial: payload.plan.targets.filter(t => t.tier.startsWith('Tier 3')).length,
    };
    const confColor = payload.confidence.overallConfidence >= 70 ? '#5cb85c'
                    : payload.confidence.overallConfidence >= 40 ? '#f0ad4e' : '#d9534f';

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Veris Dashboard</title>
<script src="https://unpkg.com/vis-network/standalone/umd/vis-network.min.js"></script>
<style>
  :root { --bg:#0f1115; --panel:#181b22; --panel2:#1f232c; --text:#e6e8ec; --muted:#9aa3b2;
          --accent:#4f8cff; --danger:#ff5d6c; --warn:#ffb347; --ok:#3ddc97; --border:#2a2f3a; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: -apple-system, "Segoe UI", Roboto, sans-serif; background:var(--bg); color:var(--text); }
  header { padding: 18px 28px; border-bottom:1px solid var(--border); display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px; background:var(--panel); }
  header h1 { font-size: 20px; margin:0; }
  header .meta { font-size: 12px; color: var(--muted); }
  .layout { display:grid; grid-template-columns: 1fr 1fr 1fr; gap:16px; padding:20px; }
  .full { grid-column: 1 / -1; }
  .half { grid-column: span 1; }
  .card { background:var(--panel); border:1px solid var(--border); border-radius:10px; padding:16px 20px; min-height: 80px; }
  .card h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin: 0 0 12px; }
  .stat-row { display:flex; gap:14px; flex-wrap:wrap; }
  .stat { flex:1; min-width:120px; background:var(--panel2); padding:14px; border-radius:8px; }
  .stat .label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; }
  .stat .value { font-size: 22px; font-weight: 600; margin-top: 4px; }
  .gauge { position: relative; height: 140px; display:flex; align-items:center; justify-content:center; }
  .gauge svg { transform: rotate(-90deg); }
  .gauge .label { position:absolute; text-align:center; }
  .gauge .label .v { font-size: 32px; font-weight: 700; }
  .gauge .label .s { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; }
  #graph { height: 460px; background: #0a0c10; border-radius: 8px; border:1px solid var(--border); }
  .legend { display:flex; gap:14px; margin-top:8px; font-size:12px; color: var(--muted); flex-wrap:wrap; }
  .legend .dot { display:inline-block; width:10px; height:10px; border-radius:50%; margin-right:6px; vertical-align:middle; }
  table { width:100%; border-collapse: collapse; font-size: 13px; }
  th, td { padding: 8px 10px; text-align:left; border-bottom:1px solid var(--border); }
  th { color: var(--muted); font-weight: 500; cursor: pointer; user-select:none; }
  th:hover { color: var(--accent); }
  td.id { font-family: "SFMono-Regular", Consolas, monospace; font-size: 11px; color: var(--muted); max-width: 360px; overflow:hidden; text-overflow: ellipsis; white-space:nowrap; }
  .pill { display:inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; }
  .pill.high { background: rgba(255,93,108,0.15); color: var(--danger); }
  .pill.med  { background: rgba(255,179,71,0.15); color: var(--warn); }
  .pill.low  { background: rgba(61,220,151,0.15); color: var(--ok); }
  .pill.t1   { background: rgba(79,140,255,0.15); color: var(--accent); }
  .pill.t2   { background: rgba(255,179,71,0.15); color: var(--warn); }
  .pill.t3   { background: rgba(255,93,108,0.15); color: var(--danger); }
  .filters { display:flex; gap:8px; margin-bottom:10px; flex-wrap:wrap; }
  .filters input, .filters select { background:var(--panel2); color:var(--text); border:1px solid var(--border); padding:6px 10px; border-radius:6px; font-size:12px; }
  details { background:var(--panel2); border:1px solid var(--border); border-radius:6px; padding:8px 12px; margin-bottom:6px; }
  details > summary { cursor:pointer; font-size:13px; }
  .copy-btn { background: var(--accent); color:#fff; border:none; padding:4px 10px; border-radius:5px; cursor:pointer; font-size: 11px; }
  .copy-btn:hover { background: #3a7be8; }
  .copy-btn.done { background: var(--ok); }
  .assumption { background:var(--panel2); padding:10px 12px; border-radius:6px; margin-bottom:6px; font-size: 13px; border-left: 3px solid var(--warn); }
  .explain { font-size: 12px; color: var(--muted); margin-top: 8px; line-height: 1.5; }
  .scroll { max-height: 360px; overflow-y: auto; }
  .scroll::-webkit-scrollbar { width: 8px; }
  .scroll::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
  .toast { position: fixed; bottom: 20px; right: 20px; background: var(--ok); color:#0a0c10; padding: 10px 16px; border-radius: 6px; font-weight:600; opacity: 0; transition: opacity 0.3s; pointer-events:none; }
  .toast.show { opacity: 1; }
  .workflow-grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; }
  .workflow-card { background: var(--panel2); border:1px solid var(--border); border-left: 4px solid var(--accent); border-radius: 8px; padding: 14px; position:relative; cursor:pointer; transition: transform 0.15s; }
  .workflow-card:hover { transform: translateY(-1px); border-color: var(--accent); }
  .workflow-card.risk-high { border-left-color: var(--danger); }
  .workflow-card.risk-med  { border-left-color: var(--warn); }
  .workflow-card.risk-low  { border-left-color: var(--ok); }
  .workflow-card.untouched { opacity: 0.55; }
  .workflow-card h3 { margin: 0 0 6px; font-size: 14px; }
  .workflow-card .narr { font-size: 12px; color: var(--muted); line-height: 1.5; margin-bottom: 8px; }
  .workflow-card .meta-row { display:flex; gap:8px; font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; }
  .workflow-card .risk-num { font-size: 22px; font-weight: 700; }
  .workflow-card .risks-list { margin-top: 8px; font-size: 11px; color: var(--warn); }
  .workflow-card .risks-list li { margin-left: 14px; }
  .workflow-card .signals { margin-top: 8px; font-size: 10px; color: var(--muted); font-family: monospace; max-height: 36px; overflow:hidden; }
  .heatmap { display:grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 6px; }
  .heatcell { padding: 12px 10px; border-radius: 6px; font-size: 12px; color: #0a0c10; font-weight: 600; cursor:pointer; transition: transform 0.1s; min-height: 56px; display:flex; flex-direction:column; justify-content:space-between; }
  .heatcell:hover { transform: scale(1.03); }
  .heatcell .v { font-size: 18px; font-weight: 700; }
  .heatcell .lbl { font-size: 10px; text-transform:uppercase; letter-spacing: 0.04em; }
  .drift-item { background:var(--panel2); border-left: 3px solid var(--accent); padding: 8px 12px; margin-bottom: 6px; border-radius: 4px; font-size: 12px; }
  .drift-item.changed { border-left-color: var(--warn); }
  .drift-item.silent { border-left-color: var(--danger); }
  .drift-item.oscillating { border-left-color: var(--danger); background: rgba(255,93,108,0.05); }
  .probe-item { background:var(--panel2); border-radius: 6px; padding: 10px 12px; margin-bottom: 6px; border-left: 3px solid var(--accent); }
  .probe-item.severity-high { border-left-color: var(--danger); }
  .probe-item.severity-medium { border-left-color: var(--warn); }
  .probe-item.severity-low { border-left-color: var(--ok); }
  .probe-item .cat { display:inline-block; padding: 1px 6px; background: var(--bg); border-radius: 4px; font-size: 10px; color: var(--muted); margin-right: 6px; text-transform: uppercase; letter-spacing: 0.04em; }
  .probe-item .scen { font-size: 13px; margin: 6px 0; }
  .probe-item .inv { font-size: 11px; color: var(--muted); font-style: italic; }
  .budget-row { display:grid; grid-template-columns: 60px 1fr 80px 60px; gap: 8px; padding: 6px 10px; font-size: 12px; align-items: center; border-bottom: 1px solid var(--border); }
  .budget-row:hover { background: var(--panel2); }
  .badge-tier { display:inline-block; padding:1px 6px; border-radius: 3px; font-size: 10px; font-weight: 600; }
  .badge-tier.t1 { background: rgba(79,140,255,0.2); color: var(--accent); }
  .badge-tier.t2 { background: rgba(255,179,71,0.2); color: var(--warn); }
  .badge-tier.t3 { background: rgba(255,93,108,0.2); color: var(--danger); }
  @media (max-width: 1000px) { .layout { grid-template-columns: 1fr 1fr; } .half { grid-column: span 1; } }
  @media (max-width: 700px)  { .layout { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<header>
  <div>
    <h1>Veris Dashboard</h1>
    <div class="meta" id="metaLine"></div>
  </div>
  <div class="meta" id="genTime"></div>
</header>

<div class="layout">
  <!-- Confidence Gauge -->
  <div class="card half">
    <h2>Overall Confidence</h2>
    <div class="gauge">
      <svg width="160" height="160" viewBox="0 0 160 160">
        <circle cx="80" cy="80" r="68" fill="none" stroke="#2a2f3a" stroke-width="12"/>
        <circle id="gaugeArc" cx="80" cy="80" r="68" fill="none" stroke="${confColor}" stroke-width="12"
                stroke-linecap="round" stroke-dasharray="${(payload.confidence.overallConfidence/100*427).toFixed(1)} 427"/>
      </svg>
      <div class="label">
        <div class="v" style="color:${confColor}">${payload.confidence.overallConfidence}</div>
        <div class="s">of 100</div>
      </div>
    </div>
    <div class="explain">Execution depth: <strong>${payload.confidence.executionDepth}%</strong></div>
  </div>

  <!-- Repo Health -->
  <div class="card half">
    <h2>Repository Health</h2>
    <div class="stat-row">
      <div class="stat"><div class="label">Nodes</div><div class="value">${totalNodes}</div></div>
      <div class="stat"><div class="label">Edges</div><div class="value">${totalEdges}</div></div>
      <div class="stat"><div class="label">High Risks</div><div class="value" style="color:var(--danger)">${highRiskCount}</div></div>
    </div>
  </div>

  <!-- Coverage -->
  <div class="card half">
    <h2>Verification Coverage</h2>
    <div class="stat-row">
      <div class="stat"><div class="label">Tier 1</div><div class="value" style="color:var(--accent)">${targetsByTier.structural}</div></div>
      <div class="stat"><div class="label">Tier 2</div><div class="value" style="color:var(--warn)">${targetsByTier.behavioral}</div></div>
      <div class="stat"><div class="label">Tier 3</div><div class="value" style="color:var(--danger)">${targetsByTier.adversarial}</div></div>
    </div>
    <div class="explain">Total directives: <strong>${payload.plan.targets.length}</strong></div>
  </div>

  <!-- Affected Behaviors (Hero) -->
  <div class="card full" id="workflowsCard">
    <h2>Affected Behaviors <span style="text-transform:none; color:var(--muted); font-size:12px; margin-left:8px;">click a workflow to filter the rest of the dashboard</span></h2>
    <div id="workflowGrid" class="workflow-grid"></div>
  </div>

  <!-- Confidence Heatmap (per-workflow) -->
  <div class="card full" id="heatmapCard">
    <h2>Confidence Heatmap</h2>
    <div id="heatmap" class="heatmap"></div>
    <div class="explain">Cell color = max risk in that workflow. Hover for detail. Click to filter.</div>
  </div>

  <!-- Confidence Trend -->
  <div class="card half" id="trendCard">
    <h2>Confidence Over Time</h2>
    <svg id="trendChart" width="100%" height="120" viewBox="0 0 400 120" preserveAspectRatio="none"></svg>
    <div class="explain" id="trendNote"></div>
  </div>

  <!-- Drift -->
  <div class="card half" id="driftCard">
    <h2>Behavioral Drift</h2>
    <div id="driftSummary" class="explain"></div>
    <div id="driftList" class="scroll" style="max-height: 200px"></div>
  </div>

  <!-- Adversarial Probes -->
  <div class="card full" id="probesCard">
    <h2>Adversarial Probes (Tier 3 hypotheses)</h2>
    <div class="filters">
      <input id="probeFilter" placeholder="Filter probes by node or workflow..." />
      <select id="probeSeverity">
        <option value="">All severities</option>
        <option value="high">High</option>
        <option value="medium">Medium</option>
        <option value="low">Low</option>
      </select>
      <button class="copy-btn" id="copyAllProbes" style="padding:6px 12px">Copy ALL filtered probes</button>
    </div>
    <div id="probeList" class="scroll"></div>
  </div>

  <!-- Verification Budget -->
  <div class="card full" id="budgetCard">
    <h2>Verification Budget Allocator</h2>
    <div class="filters">
      <label style="font-size:12px;color:var(--muted)">Budget (min): <input id="budgetInput" type="number" min="1" max="600" value="15" style="width:80px"></label>
      <button class="copy-btn" id="recomputeBudget" style="padding:6px 12px">Recompute</button>
      <button class="copy-btn" id="copyBudgetPrompt" style="padding:6px 12px; background: var(--ok); color:#0a0c10">Copy plan to clipboard</button>
    </div>
    <div id="budgetNarrative" class="explain"></div>
    <div id="budgetList" class="scroll"></div>
  </div>

  <!-- Workflow Risk Map -->
  <div class="card full">
    <h2>Workflow Risk Map (Behavioral Graph) <span id="graphFilterLabel" style="text-transform:none; color:var(--muted); font-size:12px; margin-left:8px;"></span></h2>
    <div id="graph"></div>
    <div class="legend">
      <span><span class="dot" style="background:#5b8def"></span>Service / Class</span>
      <span><span class="dot" style="background:#9b89ff"></span>Method</span>
      <span><span class="dot" style="background:#6ad7c1"></span>Function</span>
      <span><span class="dot" style="background:var(--danger)"></span>High risk (impacted)</span>
      <span><span class="dot" style="background:var(--warn)"></span>Added in diff</span>
    </div>
  </div>

  <!-- Diff Viewer -->
  <div class="card half">
    <h2>Behavioral Diff</h2>
    <div class="stat-row">
      <div class="stat"><div class="label">Added Nodes</div><div class="value" style="color:var(--ok)">+${payload.diff.addedNodes.length}</div></div>
      <div class="stat"><div class="label">Removed</div><div class="value" style="color:var(--danger)">-${payload.diff.removedNodes.length}</div></div>
      <div class="stat"><div class="label">Impacted</div><div class="value" style="color:var(--warn)">${payload.diff.impactedNodes.length}</div></div>
    </div>
    <details class="explain" style="margin-top:12px"><summary>Added node list</summary>
      <div class="scroll">${payload.diff.addedNodes.map(n => `<div style="font-family:monospace;font-size:11px;color:var(--muted);padding:2px 0;">+ ${escapeHtml(n.label)} <span style="opacity:0.6">(${escapeHtml(n.id)})</span></div>`).join('')}</div>
    </details>
  </div>

  <!-- Unverified Assumptions -->
  <div class="card half">
    <h2>Unverified Assumptions</h2>
    <div class="scroll">
      ${payload.confidence.unverifiedAssumptions.map(a => `<div class="assumption">${escapeHtml(a)}</div>`).join('') || '<div class="explain">None flagged.</div>'}
    </div>
  </div>

  <!-- Confidence Explainability -->
  <div class="card half">
    <h2>Confidence Reasoning</h2>
    <div class="explain">${payload.confidence.explanation.map(e => `<div style="margin-bottom:6px">• ${escapeHtml(e)}</div>`).join('')}</div>
  </div>

  <!-- Risk Table -->
  <div class="card full">
    <h2>Top Risk Factors (click row to expand)</h2>
    <div class="filters">
      <input id="riskFilter" placeholder="Filter risks by node id..." />
      <select id="riskSort">
        <option value="risk">Sort: Overall Risk</option>
        <option value="blast">Sort: Blast Radius</option>
        <option value="frag">Sort: Fragility</option>
        <option value="crit">Sort: Criticality</option>
      </select>
    </div>
    <div class="scroll">
      <table id="riskTable">
        <thead><tr><th>Node</th><th>Risk</th><th>Blast</th><th>Crit</th><th>Frag</th><th>Integ</th></tr></thead>
        <tbody id="riskBody"></tbody>
      </table>
    </div>
  </div>

  <!-- Verification Targets -->
  <div class="card full">
    <h2>Verification Targets — click "Copy" to send directive to Claude</h2>
    <div class="filters">
      <input id="targetFilter" placeholder="Filter targets..." />
      <select id="tierFilter">
        <option value="">All tiers</option>
        <option value="Tier 1">Tier 1 — Structural</option>
        <option value="Tier 2">Tier 2 — Behavioral</option>
        <option value="Tier 3">Tier 3 — Adversarial</option>
      </select>
      <select id="priFilter">
        <option value="">All priorities</option>
        <option value="High">High</option>
        <option value="Medium">Medium</option>
        <option value="Low">Low</option>
      </select>
      <button class="copy-btn" id="copyAll" style="padding:6px 12px">Copy ALL filtered as prompt</button>
    </div>
    <div id="targetList" class="scroll"></div>
  </div>

  <!-- Execution Recommendations -->
  <div class="card full">
    <h2>Execution Recommendations</h2>
    <ul style="margin:0; padding-left:18px; font-size:13px; line-height:1.7;">
      ${payload.plan.executionRecommendations.map(r => `<li>${escapeHtml(r)}</li>`).join('')}
    </ul>
  </div>
</div>

<div id="toast" class="toast">Copied to clipboard</div>

<script>
const PAYLOAD = ${json};

// Header meta
const m = PAYLOAD.meta || {};
document.getElementById('metaLine').textContent =
  'Diff mode: ' + (m.diffMode || 'n/a') +
  (m.baseRef ? ' • base: ' + m.baseRef : '') +
  (m.headRef ? ' • head: ' + m.headRef.substring(0,7) : '') +
  (m.projectRoot ? ' • ' + m.projectRoot : '');
document.getElementById('genTime').textContent = m.generatedAt || '';

// Build node lookup sets
const impactedSet = new Set((PAYLOAD.diff.impactedNodes || []).map(n => n.id));
const addedSet = new Set((PAYLOAD.diff.addedNodes || []).map(n => n.id));
const riskMap = {};
(PAYLOAD.risks || []).forEach(r => { riskMap[r.nodeId] = r.score; });

// Workflow indexes
const WORKFLOWS = (PAYLOAD.workflows && PAYLOAD.workflows.aggregates) || [];
const WF_DOMAINS = (PAYLOAD.workflows && PAYLOAD.workflows.workflows) || [];
const nodeToWorkflow = {}; // nodeId -> workflowId
WF_DOMAINS.forEach(d => { (d.memberNodeIds || []).forEach(id => { nodeToWorkflow[id] = d.id; }); });
let activeWorkflowFilter = null;

const wfColorPalette = ['#5b8def','#9b89ff','#6ad7c1','#ffb347','#c897f0','#ff8da1','#62c9ff','#a8e6cf','#ffd966','#f6a6b2','#7ed6df','#dcd6f7'];
const workflowColors = {};
WF_DOMAINS.forEach((d, i) => { workflowColors[d.id] = wfColorPalette[i % wfColorPalette.length]; });

// Graph viz via vis-network — nodes colored by workflow when available
const nodeTypeColorFallback = { 0: '#5b8def', 1: '#ffb347', 2: '#9b89ff', 3: '#6ad7c1', 4: '#c897f0' };
function nodeColor(n) {
  const wfId = nodeToWorkflow[n.id];
  if (wfId && workflowColors[wfId]) return workflowColors[wfId];
  return nodeTypeColorFallback[n.type] || '#9b89ff';
}
const visNodes = (PAYLOAD.graph.nodes || []).map(n => {
  const risk = riskMap[n.id];
  const color = nodeColor(n);
  let borderColor = color;
  if (risk && risk.overallRisk >= 50) { borderColor = '#ff5d6c'; }
  if (addedSet.has(n.id)) { borderColor = '#ffb347'; }
  const size = risk ? 12 + Math.min(risk.overallRisk / 4, 18) : 10;
  const wfId = nodeToWorkflow[n.id];
  const wfName = wfId ? (WF_DOMAINS.find(d => d.id === wfId) || {}).name : null;
  return {
    id: n.id,
    label: n.label,
    title: n.id + (wfName ? '\\nWorkflow: ' + wfName : '') + (risk ? '\\nRisk: ' + risk.overallRisk.toFixed(1) : ''),
    color: { background: color, border: borderColor, highlight: { background: color, border: '#fff' } },
    size: size,
    font: { color: '#e6e8ec', size: 11 },
    borderWidth: borderColor === color ? 1 : 3,
    shape: 'dot',
    _wf: wfId
  };
});
const edgeTypeColor = { 'INVOKES': '#5b8def', 'DEPENDS_ON': '#3a3f4a', 'MUTATES': '#ff5d6c', 'SYNCHRONIZES': '#ffb347' };
const visEdges = (PAYLOAD.graph.edges || []).map((e, i) => ({
  id: i,
  from: e.sourceId,
  to: e.targetId,
  arrows: 'to',
  color: { color: edgeTypeColor[e.type] || '#3a3f4a', opacity: 0.5 },
  width: e.type === 'INVOKES' ? 1.5 : 1
}));
const networkNodeDataSet = new vis.DataSet(visNodes);
const networkEdgeDataSet = new vis.DataSet(visEdges);
const network = new vis.Network(
  document.getElementById('graph'),
  { nodes: networkNodeDataSet, edges: networkEdgeDataSet },
  {
    physics: { stabilization: { iterations: 120 }, barnesHut: { gravitationalConstant: -8000, springLength: 120 } },
    interaction: { hover: true, tooltipDelay: 100 },
    layout: { improvedLayout: true }
  }
);

// Render workflow hero cards
function renderWorkflows() {
  const grid = document.getElementById('workflowGrid');
  if (!grid) return;
  if (WORKFLOWS.length === 0) { grid.innerHTML = '<div class="explain">No workflows classified.</div>'; return; }
  grid.innerHTML = WORKFLOWS.map(w => {
    const riskCls = w.maxRisk >= 50 ? 'risk-high' : w.maxRisk >= 30 ? 'risk-med' : w.impactedCount > 0 ? 'risk-low' : 'untouched';
    const active = activeWorkflowFilter === w.workflowId ? ' style="outline: 2px solid var(--accent); outline-offset: 2px;"' : '';
    const signals = (WF_DOMAINS.find(d => d.id === w.workflowId) || {}).signals || [];
    const sigStr = signals.slice(0, 6).map(s => s.source + ':' + s.value).join(' • ');
    const runtimeRisksHtml = w.runtimeRisks && w.runtimeRisks.length > 0
      ? '<ul class="risks-list">' + w.runtimeRisks.slice(0, 3).map(r => '<li>' + esc(r) + '</li>').join('') + '</ul>'
      : '';
    return '<div class="workflow-card ' + riskCls + '" data-wf="' + w.workflowId + '"' + active + '>' +
      '<h3>' + esc(w.workflowName) + '</h3>' +
      '<div class="narr">' + esc(w.narrative) + '</div>' +
      '<div class="meta-row">' +
        '<span>' + w.memberCount + ' nodes</span>' +
        '<span style="color:var(--warn)">' + w.impactedCount + ' impacted</span>' +
        '<span style="margin-left:auto" class="risk-num" title="Max risk">' + (w.maxRisk || 0).toFixed(0) + '</span>' +
      '</div>' +
      runtimeRisksHtml +
      (sigStr ? '<div class="signals" title="Inference signals">' + esc(sigStr) + '</div>' : '') +
    '</div>';
  }).join('');
  grid.querySelectorAll('.workflow-card').forEach(card => {
    card.addEventListener('click', () => {
      const wf = card.dataset.wf;
      activeWorkflowFilter = (activeWorkflowFilter === wf) ? null : wf;
      applyWorkflowFilter();
      renderWorkflows();
    });
  });
}

function applyWorkflowFilter() {
  const label = document.getElementById('graphFilterLabel');
  if (activeWorkflowFilter) {
    const wf = WORKFLOWS.find(w => w.workflowId === activeWorkflowFilter);
    label.textContent = '— filtered to: ' + (wf ? wf.workflowName : activeWorkflowFilter);
    // hide non-matching nodes in graph
    networkNodeDataSet.forEach(n => {
      networkNodeDataSet.update({ id: n.id, hidden: n._wf !== activeWorkflowFilter });
    });
  } else {
    label.textContent = '';
    networkNodeDataSet.forEach(n => networkNodeDataSet.update({ id: n.id, hidden: false }));
  }
  // Propagate to risk + target tables
  if (typeof renderRisks === 'function') renderRisks();
  if (typeof renderTargets === 'function') renderTargets();
}
renderWorkflows();

// Confidence Heatmap
function renderHeatmap() {
  const el = document.getElementById('heatmap'); if (!el) return;
  if (WORKFLOWS.length === 0) { el.innerHTML = '<div class="explain">No workflows.</div>'; return; }
  el.innerHTML = WORKFLOWS.map(w => {
    const risk = w.maxRisk || 0;
    const r = Math.min(255, Math.round(80 + (risk / 100) * 175));
    const g = Math.max(60, Math.round(220 - (risk / 100) * 160));
    const b = Math.max(60, Math.round(150 - (risk / 100) * 90));
    const bg = 'rgb(' + r + ',' + g + ',' + b + ')';
    return '<div class="heatcell" data-wf="' + w.workflowId + '" style="background:' + bg + '" title="' + esc(w.narrative) + '">' +
      '<div class="lbl">' + esc(w.workflowName) + '</div>' +
      '<div class="v">' + (w.maxRisk || 0).toFixed(0) + '</div>' +
    '</div>';
  }).join('');
  el.querySelectorAll('.heatcell').forEach(c => {
    c.addEventListener('click', () => {
      const wf = c.dataset.wf;
      activeWorkflowFilter = (activeWorkflowFilter === wf) ? null : wf;
      applyWorkflowFilter();
      renderWorkflows();
    });
  });
}
renderHeatmap();

// Confidence trend
function renderTrend() {
  const svg = document.getElementById('trendChart'); if (!svg) return;
  const trend = (PAYLOAD.confidenceTrend || []).slice().reverse(); // oldest -> newest
  const note = document.getElementById('trendNote');
  if (trend.length < 2) {
    svg.innerHTML = '<text x="10" y="60" fill="#9aa3b2" font-size="12">Need more than one run to chart. Run again to see the trend.</text>';
    note.textContent = trend.length === 1 ? '1 run on record.' : 'No history yet.';
    return;
  }
  const W = 400, H = 120, pad = 8;
  const step = (W - pad * 2) / (trend.length - 1);
  const points = trend.map((r, i) => {
    const x = pad + i * step;
    const y = H - pad - (r.overallConfidence / 100) * (H - pad * 2);
    return x + ',' + y;
  }).join(' ');
  const last = trend[trend.length - 1].overallConfidence;
  const first = trend[0].overallConfidence;
  svg.innerHTML =
    '<polyline points="' + points + '" fill="none" stroke="#4f8cff" stroke-width="2"/>' +
    '<line x1="0" y1="' + (H - pad) + '" x2="' + W + '" y2="' + (H - pad) + '" stroke="#2a2f3a"/>';
  note.textContent = 'Trend over ' + trend.length + ' runs — last ' + last.toFixed(1) + ', first ' + first.toFixed(1) + ' (delta ' + (last - first).toFixed(1) + ').';
}
renderTrend();

// Drift
function renderDrift() {
  const summary = document.getElementById('driftSummary');
  const list = document.getElementById('driftList');
  const drift = PAYLOAD.drift;
  if (!drift || !drift.workflows || drift.workflows.length === 0) {
    summary.textContent = 'No drift data yet (first run on record).';
    list.innerHTML = '';
    return;
  }
  summary.textContent = drift.summary;
  list.innerHTML = drift.workflows.map(d => {
    const cls = d.oscillationDetected ? 'oscillating' :
                (d.changedSinceLastRun && d.memberChange === 0) ? 'silent' :
                d.changedSinceLastRun ? 'changed' : '';
    return '<div class="drift-item ' + cls + '">' + esc(d.narrative) + '</div>';
  }).join('');
}
renderDrift();

// Adversarial probes
function renderProbes() {
  const list = document.getElementById('probeList');
  const probes = PAYLOAD.probes || [];
  const filter = (document.getElementById('probeFilter').value || '').toLowerCase();
  const sev = document.getElementById('probeSeverity').value;
  const filtered = probes.filter(p =>
    (p.nodeId.toLowerCase().includes(filter) || (p.workflowKind || '').toLowerCase().includes(filter)) &&
    (!sev || p.severity === sev) &&
    (!activeWorkflowFilter || p.workflowId === activeWorkflowFilter)
  );
  list.innerHTML = filtered.map((p, i) => {
    return '<div class="probe-item severity-' + p.severity + '">' +
      '<div><span class="cat">' + p.category + '</span><span class="cat">' + p.severity + '</span>' +
      '<span style="font-family:monospace;font-size:11px;color:var(--muted)">' + esc(shortId(p.nodeId)) + '</span>' +
      (p.workflowKind ? ' <span class="cat">' + esc(p.workflowKind) + '</span>' : '') +
      '<button class="copy-btn" data-i="' + i + '" style="float:right">Copy</button></div>' +
      '<div class="scen">' + esc(p.scenario) + '</div>' +
      '<div class="inv">Expected invariant: ' + esc(p.expectedInvariant) + '</div>' +
    '</div>';
  }).join('') || '<div class="explain">No probes match.</div>';
  list.querySelectorAll('.copy-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const p = filtered[parseInt(btn.dataset.i, 10)];
      const prompt = 'Veris adversarial probe [' + p.severity + ' / ' + p.category + '] for ' + p.nodeId + ':\\n' +
                     'Scenario: ' + p.scenario + '\\n' +
                     'Expected invariant: ' + p.expectedInvariant + '\\n\\n' +
                     'Please design and execute a test that exercises this scenario, then report whether the invariant holds.';
      copyToClipboard(prompt, btn);
    });
  });
}
document.getElementById('probeFilter').addEventListener('input', renderProbes);
document.getElementById('probeSeverity').addEventListener('change', renderProbes);
document.getElementById('copyAllProbes').addEventListener('click', () => {
  const probes = PAYLOAD.probes || [];
  const filter = (document.getElementById('probeFilter').value || '').toLowerCase();
  const sev = document.getElementById('probeSeverity').value;
  const filtered = probes.filter(p =>
    (p.nodeId.toLowerCase().includes(filter) || (p.workflowKind || '').toLowerCase().includes(filter)) &&
    (!sev || p.severity === sev) &&
    (!activeWorkflowFilter || p.workflowId === activeWorkflowFilter)
  );
  const prompt = 'Veris adversarial probe batch (' + filtered.length + '):\\n\\n' +
    filtered.map((p, i) => (i+1) + '. [' + p.severity + '/' + p.category + '] ' + p.nodeId + '\\n   Scenario: ' + p.scenario + '\\n   Invariant: ' + p.expectedInvariant).join('\\n\\n') +
    '\\n\\nPlease design tests for each and report which invariants hold.';
  copyToClipboard(prompt, document.getElementById('copyAllProbes'));
});
renderProbes();

// Budget allocator (recomputed client-side using payload data for live what-if)
const TIER_LEVERAGE = { 'Tier 1': 1, 'Tier 2': 3, 'Tier 3': 7 };
const TIER_COST = { 'Tier 1': 5, 'Tier 2': 30, 'Tier 3': 120 };
const WF_CRIT = { 'Payments': 2.0,'Authentication': 2.0,'Authorization': 1.8,'Webhooks': 1.8,'Billing': 1.7,'Checkout': 1.7,'Session': 1.6,'Persistence': 1.5,'Queue': 1.5,'Sync': 1.4,'Orchestration': 1.4,'Realtime': 1.3,'Caching': 1.2,'Notifications': 1.1,'AI': 1.5,'Routing': 1.4,'Cart': 1.2,'Search': 1.0,'Profile': 0.9,'Admin': 1.2,'Analytics': 0.8,'Onboarding': 1.0,'Reporting': 0.7,'Configuration': 0.7,'Infrastructure': 0.8,'Core': 1.0,'Uncategorized': 0.7 };
function renderBudget() {
  const minutes = parseInt(document.getElementById('budgetInput').value, 10) || 15;
  const budgetSec = minutes * 60;
  const targets = (PAYLOAD.plan.targets || []).slice();
  const riskByNode = {}; (PAYLOAD.risks || []).forEach(r => { riskByNode[r.nodeId] = r.score.overallRisk; });
  const wfByNode = {}; (WF_DOMAINS || []).forEach(d => { (d.memberNodeIds||[]).forEach(id => { wfByNode[id] = d; }); });
  const scored = targets.map(t => {
    const tierKey = t.tier.split(' - ')[0];
    const tier = TIER_LEVERAGE[tierKey] || 1;
    const cost = TIER_COST[tierKey] || 5;
    const risk = riskByNode[t.nodeId] || 10;
    const wf = wfByNode[t.nodeId];
    const crit = wf ? (WF_CRIT[wf.kind] || 1) : 1;
    return { ...t, _score: (tier * crit * (risk / 10)) / cost, _cost: cost, _wf: wf ? wf.name : '' };
  }).sort((a,b) => b._score - a._score);
  const selected = []; let used = 0;
  for (const t of scored) { if (used + t._cost <= budgetSec) { selected.push(t); used += t._cost; } }
  document.getElementById('budgetNarrative').textContent =
    'Selected ' + selected.length + ' of ' + targets.length + ' targets, estimated ' + Math.round(used/60) + '/' + minutes + ' min.';
  document.getElementById('budgetList').innerHTML = selected.slice(0, 200).map(t => {
    const tierKey = t.tier.split(' - ')[0];
    const cls = tierKey === 'Tier 1' ? 't1' : tierKey === 'Tier 2' ? 't2' : 't3';
    return '<div class="budget-row">' +
      '<span class="badge-tier ' + cls + '">' + tierKey + '</span>' +
      '<span style="font-family:monospace;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + esc(t.nodeId) + '">' + esc(shortId(t.nodeId)) + '</span>' +
      '<span style="color:var(--muted)">' + (t._wf || '-') + '</span>' +
      '<span style="text-align:right;color:var(--muted)">' + t._cost + 's</span>' +
    '</div>';
  }).join('');
}
document.getElementById('recomputeBudget').addEventListener('click', renderBudget);
document.getElementById('budgetInput').addEventListener('change', renderBudget);
document.getElementById('copyBudgetPrompt').addEventListener('click', () => {
  const minutes = parseInt(document.getElementById('budgetInput').value, 10) || 15;
  const list = document.querySelectorAll('#budgetList .budget-row');
  const lines = [];
  list.forEach((row, i) => lines.push((i+1) + '. ' + row.children[1].textContent));
  const prompt = 'Veris ' + minutes + '-minute verification plan (highest-leverage subset):\\n\\n' + lines.join('\\n') +
    '\\n\\nPlease execute these in order, then report which passed and which failed via mcp__veris__report_execution.';
  copyToClipboard(prompt, document.getElementById('copyBudgetPrompt'));
});
renderBudget();

// Risk table
function renderRisks() {
  const filter = document.getElementById('riskFilter').value.toLowerCase();
  const sortBy = document.getElementById('riskSort').value;
  const sorters = {
    risk: (a,b) => b.score.overallRisk - a.score.overallRisk,
    blast: (a,b) => b.score.blastRadius - a.score.blastRadius,
    frag: (a,b) => b.score.dependencyFragility - a.score.dependencyFragility,
    crit: (a,b) => b.score.runtimeCriticality - a.score.runtimeCriticality
  };
  const filtered = (PAYLOAD.risks || []).filter(r =>
    r.nodeId.toLowerCase().includes(filter) &&
    (!activeWorkflowFilter || nodeToWorkflow[r.nodeId] === activeWorkflowFilter)
  ).sort(sorters[sortBy]);
  const body = document.getElementById('riskBody');
  body.innerHTML = filtered.map(r => {
    const cls = r.score.overallRisk >= 50 ? 'high' : r.score.overallRisk >= 30 ? 'med' : 'low';
    return '<tr><td class="id" title="' + esc(r.nodeId) + '">' + esc(shortId(r.nodeId)) + '</td>' +
           '<td><span class="pill ' + cls + '">' + r.score.overallRisk.toFixed(1) + '</span></td>' +
           '<td>' + r.score.blastRadius + '</td>' +
           '<td>' + r.score.runtimeCriticality + '</td>' +
           '<td>' + r.score.dependencyFragility + '</td>' +
           '<td>' + r.score.integrationCount + '</td></tr>';
  }).join('');
}
document.getElementById('riskFilter').addEventListener('input', renderRisks);
document.getElementById('riskSort').addEventListener('change', renderRisks);
renderRisks();

// Verification targets
function renderTargets() {
  const filter = document.getElementById('targetFilter').value.toLowerCase();
  const tier = document.getElementById('tierFilter').value;
  const pri = document.getElementById('priFilter').value;
  const filtered = (PAYLOAD.plan.targets || []).filter(t =>
    t.nodeId.toLowerCase().includes(filter) &&
    (!tier || t.tier.startsWith(tier)) &&
    (!pri || t.priority === pri) &&
    (!activeWorkflowFilter || nodeToWorkflow[t.nodeId] === activeWorkflowFilter)
  );
  const list = document.getElementById('targetList');
  list.innerHTML = filtered.map((t, i) => {
    const tierCls = t.tier.startsWith('Tier 1') ? 't1' : t.tier.startsWith('Tier 2') ? 't2' : 't3';
    const priCls = t.priority === 'High' ? 'high' : t.priority === 'Medium' ? 'med' : 'low';
    return '<details>' +
      '<summary style="display:flex;justify-content:space-between;align-items:center;gap:10px;">' +
        '<span><span class="pill ' + tierCls + '">' + t.tier.split(' - ')[0] + '</span> ' +
        '<span class="pill ' + priCls + '">' + t.priority + '</span> ' +
        '<span style="font-family:monospace;font-size:11px;color:var(--muted);">' + esc(shortId(t.nodeId)) + '</span></span>' +
        '<button class="copy-btn" data-i="' + i + '">Copy directive</button>' +
      '</summary>' +
      '<div class="explain" style="margin-top:8px">' + esc(t.directive) + '</div>' +
      '</details>';
  }).join('') || '<div class="explain">No matching targets.</div>';

  list.querySelectorAll('.copy-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const idx = parseInt(btn.dataset.i, 10);
      const t = filtered[idx];
      const prompt = 'Veris verification directive (' + t.tier + ', ' + t.priority + ' priority):\\n' +
                     'Node: ' + t.nodeId + '\\n' +
                     'Directive: ' + t.directive + '\\n\\n' +
                     'Please execute or plan execution for this directive.';
      copyToClipboard(prompt, btn);
    });
  });
}
document.getElementById('targetFilter').addEventListener('input', renderTargets);
document.getElementById('tierFilter').addEventListener('change', renderTargets);
document.getElementById('priFilter').addEventListener('change', renderTargets);
renderTargets();

document.getElementById('copyAll').addEventListener('click', () => {
  const filter = document.getElementById('targetFilter').value.toLowerCase();
  const tier = document.getElementById('tierFilter').value;
  const pri = document.getElementById('priFilter').value;
  const filtered = (PAYLOAD.plan.targets || []).filter(t =>
    t.nodeId.toLowerCase().includes(filter) &&
    (!tier || t.tier.startsWith(tier)) &&
    (!pri || t.priority === pri) &&
    (!activeWorkflowFilter || nodeToWorkflow[t.nodeId] === activeWorkflowFilter)
  );
  const prompt = 'Veris verification batch (' + filtered.length + ' directives):\\n\\n' +
    filtered.map((t,i) => (i+1) + '. [' + t.tier + ' / ' + t.priority + '] ' + t.nodeId + '\\n   -> ' + t.directive).join('\\n\\n') +
    '\\n\\nPlease execute these in order and report results.';
  copyToClipboard(prompt, document.getElementById('copyAll'));
});

function copyToClipboard(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    const orig = btn.textContent;
    btn.textContent = '✓ Copied';
    btn.classList.add('done');
    showToast();
    setTimeout(() => { btn.textContent = orig; btn.classList.remove('done'); }, 1500);
  }).catch(err => {
    alert('Clipboard failed: ' + err);
  });
}
function showToast() {
  const t = document.getElementById('toast');
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 1500);
}
function shortId(id) {
  const parts = id.split('/');
  return parts.slice(-2).join('/');
}
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as any)[c]);
}
