import * as fs from 'fs';
import * as path from 'path';
import { RiskReport, DiffReport } from '../models/RiskModels';
import { VerificationPlan, ConfidenceReport } from '../models/VerificationModels';
import { GraphNode, GraphEdge } from '../models/GraphModels';
import { WorkflowReport } from '../models/WorkflowModels';
import { DriftReport } from '../engine/DriftDetector';
import { WorkflowFingerprint } from '../engine/WorkflowFingerprint';
import { AdversarialProbe } from '../engine/AdversarialProbeGenerator';
import { BudgetAllocation } from '../engine/VerificationBudgetAllocator';
import { ConfidenceTrendRow } from '../persistence/VerisState';
import { loadRiskConfig } from '../data/DataLoader';

/**
 * ReportingEngine — markdown and single-file HTML dashboard generation.
 *
 * The file is organised in four sections:
 *   1. Types and constants.
 *   2. Data shaping — pure, typed, unit-tested (escaping, render caps, stats).
 *   3. Browser asset — assets/veris-dashboard.js, read from disk and inlined.
 *   4. Template assembly — the HTML shell that stitches 2 and 3 together.
 * Filesystem IO lives only in the ReportingEngine class at the bottom.
 */

// =====================================================================
// Section 1 — types and constants
// =====================================================================

export interface ReportMeta {
    diffMode?: 'git' | 'synthetic' | string;
    baseRef?: string;
    headRef?: string;
    projectRoot?: string;
    generatedAt?: string;
}

/**
 * Bumped from 1.1.0: the embedded payload now carries `render`, and its `graph`
 * is a capped view of the analysed graph rather than the whole of it. Anything
 * consuming the exported JSON must read `render` to know what it is looking at.
 */
export const DASHBOARD_PAYLOAD_SCHEMA_VERSION = '1.2.0';

/**
 * vis-network is loaded from a CDN, pinned to an exact version and verified with
 * a Subresource Integrity hash. Unpinned (`unpkg.com/vis-network/...`) the page
 * executed whatever that URL served at view time, in the reader's browser, with
 * no way to notice a substitution — a live supply-chain path into every report
 * (finding D3).
 *
 * The hash is the sha384 of the published 9.1.9 standalone UMD bundle (688,911
 * bytes), computed from the file itself and cross-checked byte-for-byte against
 * jsDelivr. Changing VIS_NETWORK_VERSION REQUIRES recomputing the hash:
 *
 *   curl -sSL https://unpkg.com/vis-network@<v>/standalone/umd/vis-network.min.js \
 *     | openssl dgst -sha384 -binary | openssl base64 -A
 *
 * A stale hash makes the browser refuse the script — which is the safe failure,
 * and the dashboard degrades around it with an explanation instead of a blank
 * panel.
 */
export const VIS_NETWORK_VERSION = '9.1.9';
export const VIS_NETWORK_URL = `https://unpkg.com/vis-network@${VIS_NETWORK_VERSION}/standalone/umd/vis-network.min.js`;
export const VIS_NETWORK_SRI = 'sha384-yxKDWWf0wwdUj/gPeuL11czrnKFQROnLgY8ll7En9NYoXibgg3C6NK/UDHNtUgWJ';

/** Risk at or above this scores as "high" in the dashboard's summary counters. */
export const HIGH_RISK_THRESHOLD = 50;

/**
 * Documented ceilings on what the generated page renders. They exist so a large
 * monorepo degrades legibly instead of producing a file no browser can open
 * (finding F1 — one measured dashboard was 156 MB). Every cap is reported in the
 * page as "showing N of M"; nothing is dropped silently.
 *
 * Scope: the caps reduce what is *drawn*. The embedded payload keeps the full
 * diff, risk and plan arrays so "Export JSON" stays a complete record — only the
 * graph, which is both the largest structure and the one vis-network cannot draw
 * at scale, is reduced in the payload itself. Measured on a synthetic monorepo
 * (20k nodes, 30k edges, 12k added, 20k targets) the page is ~4 MB.
 */
export interface DashboardRenderLimits {
    /** Graph nodes embedded and drawn. vis-network's layout is already unusable well below this. */
    maxNodes: number;
    /** Edges kept between surviving nodes. */
    maxEdges: number;
    /** Rows in the server-rendered "added node list". */
    maxAddedNodeRows: number;
    /** Rows the browser renders per list panel (risks, targets, probes, budget). */
    maxRows: number;
}

export const DEFAULT_RENDER_LIMITS: DashboardRenderLimits = {
    maxNodes: 1500,
    maxEdges: 4000,
    maxAddedNodeRows: 500,
    maxRows: 500,
};

/** What the page actually rendered, against what was analysed. */
export interface DashboardRenderInfo {
    shownNodes: number;
    totalNodes: number;
    shownEdges: number;
    totalEdges: number;
    truncated: boolean;
    limits: DashboardRenderLimits;
}

export interface DashboardPayload {
    schemaVersion?: string;
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
    /** Set by the renderer on the embedded copy; absent on the caller's input. */
    render?: DashboardRenderInfo;
}

/** Budget constants handed to the browser. Sourced from data/risk-config.json. */
export interface DashboardBudgetConfig {
    tierLeverage: { [tier: string]: number };
    tierCostSeconds: { [tier: string]: number };
    workflowCriticality: { [kind: string]: number };
}

export interface RenderDashboardOptions {
    limits?: Partial<DashboardRenderLimits>;
    /** Defaults to `loadRiskConfig(meta.projectRoot).budget`. */
    budget?: DashboardBudgetConfig;
    /** Defaults to the shipped assets/veris-dashboard.js. Injected by tests. */
    clientScript?: string;
}

// =====================================================================
// Section 2 — data shaping (pure, typed, unit-tested)
// =====================================================================

const HTML_ESCAPES: { [char: string]: string } = {
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
};

/**
 * Escape a value for HTML text or a quoted attribute.
 *
 * Every value below that came from analysed source, from a plugin, or from
 * persisted state goes through this. Symbol names are attacker-controlled for
 * this product's threat model: a repository under analysis can contain a class
 * whose name is a script tag, and it used to land in the reader's DOM verbatim
 * (finding D4).
 */
export function escapeHtml(value: unknown): string {
    if (value === null || value === undefined) return '';
    return String(value).replace(/[&<>"']/g, c => HTML_ESCAPES[c]);
}

/**
 * Numeric interpolation guard. Payloads cross process boundaries (MCP, JSON on
 * disk, plugins), so a field declared `number` can arrive as a string — and an
 * unescaped string in a numeric slot is an injection site.
 */
export function formatNumber(value: unknown, digits = 0): string {
    const n = Number(value);
    return (Number.isFinite(n) ? n : 0).toFixed(digits);
}

export interface DashboardStats {
    totalNodes: number;
    totalEdges: number;
    totalRisks: number;
    highRiskCount: number;
    targetsByTier: { structural: number; behavioral: number; adversarial: number };
    confidenceColor: string;
}

export function buildDashboardStats(payload: DashboardPayload): DashboardStats {
    const targets = payload.plan?.targets ?? [];
    const confidence = Number(payload.confidence?.overallConfidence) || 0;
    return {
        totalNodes: payload.graph?.nodes?.length ?? 0,
        totalEdges: payload.graph?.edges?.length ?? 0,
        totalRisks: payload.risks?.length ?? 0,
        highRiskCount: (payload.risks ?? []).filter(r => Number(r.score?.overallRisk) >= HIGH_RISK_THRESHOLD).length,
        targetsByTier: {
            structural: targets.filter(t => String(t.tier).startsWith('Tier 1')).length,
            behavioral: targets.filter(t => String(t.tier).startsWith('Tier 2')).length,
            adversarial: targets.filter(t => String(t.tier).startsWith('Tier 3')).length,
        },
        confidenceColor: confidence >= 70 ? '#5cb85c' : confidence >= 40 ? '#f0ad4e' : '#d9534f',
    };
}

export interface RenderedGraph {
    nodes: GraphNode[];
    edges: GraphEdge[];
    info: DashboardRenderInfo;
}

/**
 * Reduce the graph to what the page will render.
 *
 * Ranking matters more than the cap itself: when the graph is over the ceiling,
 * the nodes the report is *about* — everything the diff touched — are kept
 * first, then the highest-risk remainder. A truncated dashboard therefore still
 * shows the subject of the run rather than an arbitrary alphabetical prefix.
 * Nodes that survive keep their original order so output stays deterministic.
 */
export function selectRenderedGraph(
    graph: { nodes: GraphNode[]; edges: GraphEdge[] } | undefined,
    diff: DiffReport | undefined,
    risks: RiskReport[] | undefined,
    limits: DashboardRenderLimits
): RenderedGraph {
    const nodes = graph?.nodes ?? [];
    const edges = graph?.edges ?? [];

    const priority = new Set<string>();
    for (const list of [diff?.addedNodes, diff?.removedNodes, diff?.modifiedNodes, diff?.impactedNodes]) {
        for (const n of list ?? []) priority.add(n.id);
    }
    const riskByNode = new Map<string, number>();
    for (const r of risks ?? []) riskByNode.set(r.nodeId, Number(r.score?.overallRisk) || 0);

    const maxNodes = Math.max(0, limits.maxNodes);
    let keptNodes = nodes;
    if (nodes.length > maxNodes) {
        // Rank is (touched by the diff) first, then risk. The offset is larger
        // than any risk score, so a touched node always outranks an untouched one.
        const rank = (n: GraphNode): number => (priority.has(n.id) ? 1_000_000 : 0) + (riskByNode.get(n.id) ?? 0);
        const keepIds = new Set(
            [...nodes].sort((a, b) => rank(b) - rank(a)).slice(0, maxNodes).map(n => n.id)
        );
        keptNodes = nodes.filter(n => keepIds.has(n.id));
    }

    const keptIds = new Set(keptNodes.map(n => n.id));
    const connected = edges.filter(e => keptIds.has(e.sourceId) && keptIds.has(e.targetId));
    const keptEdges = connected.slice(0, Math.max(0, limits.maxEdges));

    return {
        nodes: keptNodes,
        edges: keptEdges,
        info: {
            shownNodes: keptNodes.length,
            totalNodes: nodes.length,
            shownEdges: keptEdges.length,
            totalEdges: edges.length,
            truncated: keptNodes.length < nodes.length || keptEdges.length < edges.length,
            limits,
        },
    };
}

/**
 * Serialize for embedding inside a `<script type="application/json">` block.
 * JSON is safe there except for the script closing sequence, which would end the
 * block early; `<\/script` is a valid JSON string escape and parses back
 * identically. U+2028/U+2029 are escaped too so the same string stays safe if it
 * is ever moved into a JavaScript literal.
 */
export function serializeForScriptBlock(value: unknown): string {
    return JSON.stringify(value ?? null)
        .replace(/<\/script/gi, '<\\/script')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
}

// =====================================================================
// Section 3 — browser asset
// =====================================================================

const CLIENT_ASSET_NAME = 'veris-dashboard.js';
let cachedClientScript: string | null = null;

/**
 * Reject a script that cannot be inlined. Anything placed inside a script
 * element ends it at the first closing sequence, spilling the rest into the
 * document as markup — so the asset is checked rather than trusted.
 */
export function assertInlinableScript(source: string, origin: string): void {
    if (/<\/script/i.test(source)) {
        throw new Error(`veris: ${origin} contains a script closing sequence and cannot be inlined`);
    }
}

/**
 * Read the dashboard's browser runtime from assets/.
 *
 * The build is `tsc` only — no bundler and no copy step — so the asset cannot
 * live under src/. assets/ is listed in package.json "files", so it ships in the
 * npm tarball, and the candidate list resolves both from dist/reporting (packaged)
 * and from src/reporting (ts-node, vitest). Mirrors DataLoader's resolution of
 * the shipped data/ directory.
 */
export function loadDashboardClientScript(): string {
    if (cachedClientScript !== null) return cachedClientScript;
    const candidates = [
        path.join(__dirname, '..', '..', 'assets', CLIENT_ASSET_NAME),
        path.join(__dirname, '..', 'assets', CLIENT_ASSET_NAME),
        path.join(__dirname, 'assets', CLIENT_ASSET_NAME),
    ];
    for (const candidate of candidates) {
        if (!fs.existsSync(candidate)) continue;
        const source = fs.readFileSync(candidate, 'utf8');
        assertInlinableScript(source, candidate);
        cachedClientScript = source;
        return source;
    }
    throw new Error(
        `veris: dashboard browser asset ${CLIENT_ASSET_NAME} not found. Looked in:\n  ${candidates.join('\n  ')}`
    );
}

// =====================================================================
// Section 4 — template assembly
// =====================================================================

function renderAddedNodeList(added: GraphNode[], maxRows: number): string {
    if (added.length === 0) return '<div class="explain">None.</div>';
    const rows = added.slice(0, maxRows)
        .map(n => `<div class="added-node">+ ${escapeHtml(n.label)} <span style="opacity:0.6">(${escapeHtml(n.id)})</span></div>`)
        .join('');
    const note = added.length > maxRows
        ? `<div class="cap-note">Showing ${maxRows} of ${added.length} added nodes — the full list is in the exported JSON.</div>`
        : '';
    return rows + note;
}

function renderCoverageNote(info: DashboardRenderInfo): string {
    if (!info.truncated) {
        return `Showing all ${info.totalNodes} nodes and ${info.totalEdges} edges.`;
    }
    return `Showing ${info.shownNodes} of ${info.totalNodes} nodes and ${info.shownEdges} of ${info.totalEdges} edges `
        + `(cap: ${info.limits.maxNodes} nodes / ${info.limits.maxEdges} edges). `
        + `Nodes touched by the diff and the highest-risk remainder are kept first.`;
}

export function renderDashboard(payload: DashboardPayload, options: RenderDashboardOptions = {}): string {
    const limits: DashboardRenderLimits = { ...DEFAULT_RENDER_LIMITS, ...(options.limits ?? {}) };
    const budget = options.budget ?? loadRiskConfig(payload.meta?.projectRoot ?? process.cwd()).budget;
    const clientScript = options.clientScript ?? loadDashboardClientScript();

    const rendered = selectRenderedGraph(payload.graph, payload.diff, payload.risks, limits);
    const stats = buildDashboardStats(payload);

    // The embedded payload carries the capped graph — it is what the page draws,
    // and embedding the uncapped one would defeat the cap on file size entirely.
    const embedded: DashboardPayload = {
        schemaVersion: DASHBOARD_PAYLOAD_SCHEMA_VERSION,
        ...payload,
        graph: { nodes: rendered.nodes, edges: rendered.edges },
        render: rendered.info,
    };
    const pageConfig = {
        visNetworkVersion: VIS_NETWORK_VERSION,
        render: rendered.info,
        budget,
    };

    const confidence = Number(payload.confidence?.overallConfidence) || 0;
    const gaugeArc = formatNumber((confidence / 100) * 427, 1);
    const assumptions = payload.confidence?.unverifiedAssumptions ?? [];
    const explanation = payload.confidence?.explanation ?? [];
    const recommendations = payload.plan?.executionRecommendations ?? [];

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Veris Dashboard</title>
<!-- Exact version + Subresource Integrity: the browser refuses this file if a
     single byte differs from the pinned build. See VIS_NETWORK_SRI. -->
<script src="${VIS_NETWORK_URL}" integrity="${VIS_NETWORK_SRI}" crossorigin="anonymous" referrerpolicy="no-referrer"></script>
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
  .graph-fallback { padding: 24px; font-size: 13px; color: var(--muted); line-height: 1.6; }
  .graph-fallback strong { display:block; color: var(--warn); margin-bottom: 6px; font-size: 14px; }
  .legend { display:flex; gap:14px; margin-top:8px; font-size:12px; color: var(--muted); flex-wrap:wrap; }
  .legend .dot { display:inline-block; width:10px; height:10px; border-radius:50%; margin-right:6px; vertical-align:middle; }
  table { width:100%; border-collapse: collapse; font-size: 13px; }
  th, td { padding: 8px 10px; text-align:left; border-bottom:1px solid var(--border); }
  th { color: var(--muted); font-weight: 500; cursor: pointer; user-select:none; }
  th:hover { color: var(--accent); }
  td.id { font-family: "SFMono-Regular", Consolas, monospace; font-size: 11px; color: var(--muted); max-width: 360px; overflow:hidden; text-overflow: ellipsis; white-space:nowrap; }
  .node-id { font-family: "SFMono-Regular", Consolas, monospace; font-size: 11px; color: var(--muted); }
  .node-id.ellipsis { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .added-node { font-family: "SFMono-Regular", Consolas, monospace; font-size: 11px; color: var(--muted); padding: 2px 0; }
  .cap-note { margin-top: 8px; font-size: 11px; color: var(--warn); }
  .render-note { font-size: 11px; color: var(--muted); margin-top: 8px; }
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
  .target-summary { display:flex; justify-content:space-between; align-items:center; gap:10px; }
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
  .workflow-card.is-active { outline: 2px solid var(--accent); outline-offset: 2px; }
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
  .filter-banner { position: sticky; top: 0; z-index: 50; background: rgba(79,140,255,0.12); border: 1px solid var(--accent); padding: 8px 14px; border-radius: 6px; margin: 0 20px 12px; font-size: 13px; display: none; justify-content: space-between; align-items: center; }
  .filter-banner.active { display: flex; }
  .filter-banner button { background: transparent; border: 1px solid var(--accent); color: var(--accent); padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 11px; }
  .filter-banner button:hover { background: var(--accent); color: #fff; }
  .top-actions { display:flex; gap: 8px; flex-wrap:wrap; }
  .top-actions a, .top-actions button { background: var(--panel2); border:1px solid var(--border); color: var(--text); padding: 6px 12px; border-radius: 6px; font-size: 12px; text-decoration:none; cursor:pointer; }
  .top-actions a:hover, .top-actions button:hover { border-color: var(--accent); color: var(--accent); }
  .hero-summary { background:var(--panel2); border:1px solid var(--border); border-radius:8px; padding: 14px 18px; margin-bottom: 16px; }
  .hero-summary .h-title { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 6px; }
  .hero-summary .h-body { font-size: 15px; line-height: 1.5; }
  .tier-legend { display:flex; gap: 12px; flex-wrap:wrap; font-size: 11px; color: var(--muted); margin-top: 6px; }
  .tier-legend .swatch { display:inline-block; width:10px; height:10px; border-radius:2px; margin-right: 4px; vertical-align: middle; }
  .info-tip { display:inline-block; width: 14px; height: 14px; line-height: 14px; text-align: center; border-radius: 50%; background: var(--border); color: var(--muted); font-size: 10px; cursor: help; margin-left: 4px; font-weight: 700; }
  .info-tip:hover { background: var(--accent); color: #fff; }
  .kb-hint { position: fixed; bottom: 12px; left: 12px; background: rgba(15,17,21,0.85); border:1px solid var(--border); padding: 6px 10px; border-radius: 6px; font-size: 11px; color: var(--muted); pointer-events:none; }
  @media (max-width: 1000px) { .layout { grid-template-columns: 1fr 1fr; } .half { grid-column: span 1; } }
  @media (max-width: 700px)  { .layout { grid-template-columns: 1fr; } .kb-hint { display:none; } }
</style>
</head>
<body>
<header>
  <div>
    <h1>Veris <span style="font-size:11px;color:var(--muted);font-weight:400;margin-left:6px;vertical-align: middle;">Behavioral Verification Infrastructure</span></h1>
    <div class="meta" id="metaLine"></div>
  </div>
  <div class="top-actions">
    <button id="exportJsonBtn" title="Download dashboard data as JSON">Export JSON</button>
    <button id="exportCsvBtn" title="Download targets + probes as CSV">Export CSV</button>
    <a href="https://github.com/vighriday/Veris#readme" target="_blank" rel="noopener">Docs</a>
    <span class="meta" id="genTime"></span>
  </div>
</header>

<div class="filter-banner" id="filterBanner">
  <span>Filtered to: <strong id="filterBannerName"></strong></span>
  <button id="clearFilterBtn">Clear filter (Esc)</button>
</div>

<div style="padding: 0 20px 0 20px;">
  <div class="hero-summary" id="heroSummary">
    <div class="h-title">Executive Summary</div>
    <div class="h-body" id="heroBody">Loading...</div>
  </div>
</div>

<div class="layout">
  <!-- Confidence Gauge -->
  <div class="card half">
    <h2>Overall Confidence</h2>
    <div class="gauge">
      <svg width="160" height="160" viewBox="0 0 160 160">
        <circle cx="80" cy="80" r="68" fill="none" stroke="#2a2f3a" stroke-width="12"/>
        <circle id="gaugeArc" cx="80" cy="80" r="68" fill="none" stroke="${stats.confidenceColor}" stroke-width="12"
                stroke-linecap="round" stroke-dasharray="${gaugeArc} 427"/>
      </svg>
      <div class="label">
        <div class="v" style="color:${stats.confidenceColor}">${formatNumber(confidence, 0)}</div>
        <div class="s">of 100</div>
      </div>
    </div>
    <div class="explain">Execution depth: <strong>${formatNumber(payload.confidence?.executionDepth, 0)}%</strong></div>
  </div>

  <!-- Repo Health -->
  <div class="card half">
    <h2>Repository Health</h2>
    <div class="stat-row">
      <div class="stat"><div class="label">Nodes</div><div class="value">${stats.totalNodes}</div></div>
      <div class="stat"><div class="label">Edges</div><div class="value">${stats.totalEdges}</div></div>
      <div class="stat"><div class="label">High Risks</div><div class="value" style="color:var(--danger)">${stats.highRiskCount}</div></div>
    </div>
    <div class="render-note">${escapeHtml(renderCoverageNote(rendered.info))}</div>
  </div>

  <!-- Coverage -->
  <div class="card half">
    <h2>Verification Coverage</h2>
    <div class="stat-row">
      <div class="stat" title="Structural: syntax, schemas, types, lint."><div class="label">Tier 1 <span class="info-tip">?</span></div><div class="value" style="color:var(--accent)">${stats.targetsByTier.structural}</div></div>
      <div class="stat" title="Behavioral: workflow correctness, contracts, integrations."><div class="label">Tier 2 <span class="info-tip">?</span></div><div class="value" style="color:var(--warn)">${stats.targetsByTier.behavioral}</div></div>
      <div class="stat" title="Adversarial: concurrency, retries, race conditions, malformed state."><div class="label">Tier 3 <span class="info-tip">?</span></div><div class="value" style="color:var(--danger)">${stats.targetsByTier.adversarial}</div></div>
    </div>
    <div class="explain">Total directives: <strong>${payload.plan?.targets?.length ?? 0}</strong></div>
    <div class="tier-legend">
      <span><span class="swatch" style="background:var(--accent)"></span>Structural</span>
      <span><span class="swatch" style="background:var(--warn)"></span>Behavioral</span>
      <span><span class="swatch" style="background:var(--danger)"></span>Adversarial</span>
    </div>
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
    <div class="render-note">${escapeHtml(renderCoverageNote(rendered.info))}</div>
  </div>

  <!-- Diff Viewer -->
  <div class="card half">
    <h2>Behavioral Diff</h2>
    <div class="stat-row">
      <div class="stat"><div class="label">Added Nodes</div><div class="value" style="color:var(--ok)">+${payload.diff?.addedNodes?.length ?? 0}</div></div>
      <div class="stat"><div class="label">Removed</div><div class="value" style="color:var(--danger)">-${payload.diff?.removedNodes?.length ?? 0}</div></div>
      <div class="stat"><div class="label">Impacted</div><div class="value" style="color:var(--warn)">${payload.diff?.impactedNodes?.length ?? 0}</div></div>
    </div>
    <details class="explain" style="margin-top:12px"><summary>Added node list</summary>
      <div class="scroll">${renderAddedNodeList(payload.diff?.addedNodes ?? [], limits.maxAddedNodeRows)}</div>
    </details>
  </div>

  <!-- Unverified Assumptions -->
  <div class="card half">
    <h2>Unverified Assumptions</h2>
    <div class="scroll">
      ${assumptions.map(a => `<div class="assumption">${escapeHtml(a)}</div>`).join('') || '<div class="explain">None flagged.</div>'}
    </div>
  </div>

  <!-- Confidence Explainability -->
  <div class="card half">
    <h2>Confidence Reasoning</h2>
    <div class="explain">${explanation.map(e => `<div style="margin-bottom:6px">• ${escapeHtml(e)}</div>`).join('')}</div>
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
    <div id="riskCapNote"></div>
  </div>

  <!-- Verification Targets -->
  <div class="card full">
    <h2>Verification Targets — click "Copy" to send directive to your agent</h2>
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
      ${recommendations.map(r => `<li>${escapeHtml(r)}</li>`).join('')}
    </ul>
  </div>
</div>

<div id="toast" class="toast">Copied to clipboard</div>
<div class="kb-hint">Esc: clear filter • Click workflow card or heatmap cell to filter</div>

<script id="veris-payload" type="application/json">${serializeForScriptBlock(embedded)}</script>
<script id="veris-config" type="application/json">${serializeForScriptBlock(pageConfig)}</script>
<script>
${clientScript}
</script>
</body>
</html>`;
}

// =====================================================================
// Section 5 — filesystem IO
// =====================================================================

export class ReportingEngine {

    private outputDir: string;
    private projectRoot: string;

    constructor(projectRoot: string) {
        this.projectRoot = projectRoot;
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
     *
     * The page embeds its payload as JSON and its browser runtime inline; the one
     * external request is the pinned, integrity-checked vis-network bundle, and
     * the page renders everything except the graph without it.
     *
     * Rendering is capped (see DEFAULT_RENDER_LIMITS) and every cap is stated in
     * the page, so a monorepo produces a legible partial view rather than a file
     * too large to open.
     */
    public generateDashboard(payload: DashboardPayload, options: RenderDashboardOptions = {}): string {
        const htmlPath = path.join(this.outputDir, 'veris-dashboard.html');
        const html = renderDashboard(payload, {
            ...options,
            budget: options.budget ?? loadRiskConfig(this.projectRoot).budget,
        });
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
        // Escape before applying inline markup: the markdown carries node ids and
        // explanations built from analysed source, and this converter emits raw
        // HTML. The inline patterns key off backticks, asterisks and underscores,
        // none of which escaping touches, so the order is safe.
        const inline = (s: string) => escapeHtml(s)
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
