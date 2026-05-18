import * as fs from 'fs';
import * as path from 'path';
import { RiskReport, DiffReport } from '../models/RiskModels';
import { VerificationPlan, ConfidenceReport, VerificationTarget } from '../models/VerificationModels';
import { BehavioralGraph, GraphNode, GraphEdge, NodeType, EdgeType } from '../models/GraphModels';

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

  <!-- Workflow Risk Map -->
  <div class="card full">
    <h2>Workflow Risk Map (Behavioral Graph)</h2>
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

// Graph viz via vis-network
const nodeTypeColor = { 0: '#5b8def', 1: '#ffb347', 2: '#9b89ff', 3: '#6ad7c1', 4: '#c897f0' };
const visNodes = (PAYLOAD.graph.nodes || []).map(n => {
  const risk = riskMap[n.id];
  let color = nodeTypeColor[n.type] || '#9b89ff';
  let borderColor = color;
  if (risk && risk.overallRisk >= 50) { borderColor = '#ff5d6c'; }
  if (addedSet.has(n.id)) { borderColor = '#ffb347'; }
  const size = risk ? 12 + Math.min(risk.overallRisk / 4, 18) : 10;
  return {
    id: n.id,
    label: n.label,
    title: n.id + (risk ? '\\nRisk: ' + risk.overallRisk.toFixed(1) : ''),
    color: { background: color, border: borderColor, highlight: { background: color, border: '#fff' } },
    size: size,
    font: { color: '#e6e8ec', size: 11 },
    borderWidth: borderColor === color ? 1 : 3,
    shape: 'dot'
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
const network = new vis.Network(
  document.getElementById('graph'),
  { nodes: new vis.DataSet(visNodes), edges: new vis.DataSet(visEdges) },
  {
    physics: { stabilization: { iterations: 120 }, barnesHut: { gravitationalConstant: -8000, springLength: 120 } },
    interaction: { hover: true, tooltipDelay: 100 },
    layout: { improvedLayout: true }
  }
);

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
  const filtered = (PAYLOAD.risks || []).filter(r => r.nodeId.toLowerCase().includes(filter)).sort(sorters[sortBy]);
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
    (!pri || t.priority === pri)
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
    (!pri || t.priority === pri)
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
