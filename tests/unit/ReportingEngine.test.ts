import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
    ReportingEngine,
    renderDashboard,
    selectRenderedGraph,
    buildDashboardStats,
    serializeForScriptBlock,
    escapeHtml,
    formatNumber,
    loadDashboardClientScript,
    assertInlinableScript,
    DEFAULT_RENDER_LIMITS,
    DASHBOARD_PAYLOAD_SCHEMA_VERSION,
    VIS_NETWORK_VERSION,
    VIS_NETWORK_URL,
    VIS_NETWORK_SRI,
    DashboardPayload,
    DashboardRenderLimits,
} from '../../src/reporting/ReportingEngine';
import { DiffReport } from '../../src/models/RiskModels';
import { VerificationTier } from '../../src/models/VerificationModels';
import { WorkflowKind } from '../../src/models/WorkflowModels';
import { VerificationBudgetAllocator } from '../../src/engine/VerificationBudgetAllocator';
import { loadRiskConfig } from '../../src/data/DataLoader';
import { node, risk, target, plan, domain } from './helpers';

/**
 * A symbol name that closes the surrounding script element and opens its own.
 * Node labels come from the analyzed repository, which this product treats as
 * untrusted input — a repo can contain a class named exactly this (finding D4).
 */
const XSS = '</script><script>alert(1)</script>';
const ATTR_BREAKOUT = 'x" onmouseover="alert(1)';

const PROJECT_ROOT = process.cwd();
const tmpDirs: string[] = [];

afterEach(() => {
    while (tmpDirs.length) {
        fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
    }
});

function makeTmpRoot(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veris-reporting-'));
    tmpDirs.push(dir);
    return dir;
}

function diffOf(over: Partial<DiffReport> = {}): DiffReport {
    return {
        addedNodes: [], removedNodes: [], modifiedNodes: [],
        addedEdges: [], removedEdges: [], impactedNodes: [],
        ...over,
    };
}

function payloadOf(over: Partial<DashboardPayload> = {}): DashboardPayload {
    return {
        meta: { diffMode: 'git', projectRoot: PROJECT_ROOT, generatedAt: '2026-09-07T12:00:00.000Z' },
        graph: { nodes: [], edges: [] },
        diff: diffOf(),
        risks: [],
        plan: plan([]),
        confidence: { overallConfidence: 42, executionDepth: 10, unverifiedAssumptions: [], explanation: [] },
        ...over,
    };
}

/** Pull one of the page's embedded JSON blocks back out. */
function embeddedJson(html: string, id: string): any {
    const match = new RegExp(`<script id="${id}" type="application/json">([\\s\\S]*?)</script>`).exec(html);
    expect(match, `no embedded block ${id}`).not.toBeNull();
    return JSON.parse(match![1]);
}

/**
 * Evaluate the browser asset under Node. It exports its pure helpers when a
 * CommonJS `module` is present and boots only when a `document` exists, so the
 * HTML builders and budget math are testable without a browser.
 */
function loadClient(): any {
    const source = loadDashboardClientScript();
    const mod = { exports: {} as any };
    // eslint-disable-next-line no-new-func
    new Function('module', 'exports', source)(mod, mod.exports);
    return mod.exports;
}

describe('escapeHtml', () => {
    it('escapes the five characters that change HTML meaning', () => {
        expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
    });

    it('renders null and undefined as empty rather than as their names', () => {
        expect(escapeHtml(null)).toBe('');
        expect(escapeHtml(undefined)).toBe('');
        expect(escapeHtml(0)).toBe('0');
    });

    it('neutralizes a script payload', () => {
        expect(escapeHtml(XSS)).toBe('&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
    });
});

describe('formatNumber', () => {
    it('formats finite numbers at the requested precision', () => {
        expect(formatNumber(12.345, 1)).toBe('12.3');
        expect(formatNumber(7)).toBe('7');
    });

    it('coerces a non-numeric value to 0 instead of interpolating it', () => {
        expect(formatNumber('<img onerror=alert(1)>')).toBe('0');
        expect(formatNumber(undefined, 2)).toBe('0.00');
    });
});

describe('selectRenderedGraph', () => {
    const limits: DashboardRenderLimits = { ...DEFAULT_RENDER_LIMITS };

    it('returns the whole graph untouched when it is under the ceiling', () => {
        const graph = { nodes: [node('a.ts::a'), node('b.ts::b')], edges: [] };
        const result = selectRenderedGraph(graph, diffOf(), [], limits);
        expect(result.nodes).toHaveLength(2);
        expect(result.info.truncated).toBe(false);
        expect(result.info.shownNodes).toBe(2);
        expect(result.info.totalNodes).toBe(2);
    });

    it('keeps the nodes the diff touched when the graph is over the ceiling', () => {
        const nodes = Array.from({ length: 50 }, (_, i) => node(`src/f${i}.ts::fn${i}`));
        // The touched node is last in graph order: rank, not position, must decide.
        const touched = nodes[49];
        const result = selectRenderedGraph(
            { nodes, edges: [] },
            diffOf({ impactedNodes: [touched] }),
            [],
            { ...limits, maxNodes: 3 }
        );
        expect(result.nodes).toHaveLength(3);
        expect(result.nodes.map(n => n.id)).toContain(touched.id);
        expect(result.info.truncated).toBe(true);
        expect(result.info.shownNodes).toBe(3);
        expect(result.info.totalNodes).toBe(50);
    });

    it('ranks by risk once the diff-touched nodes are in', () => {
        const nodes = Array.from({ length: 10 }, (_, i) => node(`src/f${i}.ts::fn${i}`));
        const risks = nodes.map((n, i) => risk(n.id, i * 5));
        const result = selectRenderedGraph({ nodes, edges: [] }, diffOf(), risks, { ...limits, maxNodes: 2 });
        expect(result.nodes.map(n => n.id).sort()).toEqual(['src/f8.ts::fn8', 'src/f9.ts::fn9']);
    });

    it('drops edges whose endpoints were cut, and reports the loss', () => {
        const nodes = [node('a.ts::a'), node('b.ts::b'), node('c.ts::c')];
        const edges = [
            { sourceId: 'a.ts::a', targetId: 'b.ts::b', type: 'INVOKES' as any },
            { sourceId: 'a.ts::a', targetId: 'c.ts::c', type: 'INVOKES' as any },
        ];
        const result = selectRenderedGraph(
            { nodes, edges },
            diffOf({ impactedNodes: [nodes[0], nodes[1]] }),
            [],
            { ...limits, maxNodes: 2 }
        );
        expect(result.edges).toHaveLength(1);
        expect(result.info.shownEdges).toBe(1);
        expect(result.info.totalEdges).toBe(2);
        expect(result.info.truncated).toBe(true);
    });

    it('caps edges independently of nodes', () => {
        const nodes = [node('a.ts::a'), node('b.ts::b')];
        const edges = [
            { sourceId: 'a.ts::a', targetId: 'b.ts::b', type: 'INVOKES' as any },
            { sourceId: 'b.ts::b', targetId: 'a.ts::a', type: 'DEPENDS_ON' as any },
        ];
        const result = selectRenderedGraph({ nodes, edges }, diffOf(), [], { ...limits, maxEdges: 1 });
        expect(result.edges).toHaveLength(1);
        expect(result.info.truncated).toBe(true);
    });

    it('preserves graph order among the nodes it keeps', () => {
        const nodes = [node('a.ts::a'), node('b.ts::b'), node('c.ts::c'), node('d.ts::d')];
        const result = selectRenderedGraph(
            { nodes, edges: [] },
            diffOf({ addedNodes: [nodes[2], nodes[0]] }),
            [],
            { ...limits, maxNodes: 2 }
        );
        expect(result.nodes.map(n => n.id)).toEqual(['a.ts::a', 'c.ts::c']);
    });
});

describe('buildDashboardStats', () => {
    it('counts targets per tier and risks above the high-risk threshold', () => {
        const stats = buildDashboardStats(payloadOf({
            graph: { nodes: [node('a.ts::a')], edges: [] },
            risks: [risk('a.ts::a', 80), risk('b.ts::b', 49.9)],
            plan: plan([
                target('a.ts::a', VerificationTier.Structural),
                target('b.ts::b', VerificationTier.Behavioral),
                target('c.ts::c', VerificationTier.Adversarial),
                target('d.ts::d', VerificationTier.Adversarial),
            ]),
        }));
        expect(stats.targetsByTier).toEqual({ structural: 1, behavioral: 1, adversarial: 2 });
        expect(stats.highRiskCount).toBe(1);
        expect(stats.totalNodes).toBe(1);
    });

    it('picks the gauge color from the confidence bands', () => {
        const color = (c: number) => buildDashboardStats(payloadOf({
            confidence: { overallConfidence: c, executionDepth: 0, unverifiedAssumptions: [], explanation: [] },
        })).confidenceColor;
        expect(color(70)).toBe('#5cb85c');
        expect(color(40)).toBe('#f0ad4e');
        expect(color(39.9)).toBe('#d9534f');
    });
});

describe('serializeForScriptBlock', () => {
    it('escapes a script closing sequence so the payload cannot end its own block', () => {
        const json = serializeForScriptBlock({ label: XSS });
        expect(json).not.toContain('</script');
        expect(json).toContain('<\\/script');
    });

    it('round-trips the original value through the escape', () => {
        const json = serializeForScriptBlock({ label: XSS });
        expect(JSON.parse(json).label).toBe(XSS);
    });
});

describe('renderDashboard — third-party script (D3)', () => {
    it('pins vis-network to an exact version with an integrity hash', () => {
        const html = renderDashboard(payloadOf());
        expect(html).toContain(`https://unpkg.com/vis-network@${VIS_NETWORK_VERSION}/standalone/umd/vis-network.min.js`);
        expect(html).toContain(`integrity="${VIS_NETWORK_SRI}"`);
        expect(html).toContain('crossorigin="anonymous"');
        expect(VIS_NETWORK_SRI.startsWith('sha384-')).toBe(true);
    });

    it('never references the library without a version', () => {
        const html = renderDashboard(payloadOf());
        expect(html).not.toContain('unpkg.com/vis-network/');
    });

    it('loads exactly one remote script, and it is the pinned one', () => {
        const html = renderDashboard(payloadOf());
        const remote = html.match(/<script[^>]+src="([^"]+)"/g) ?? [];
        expect(remote).toHaveLength(1);
        expect(remote[0]).toContain(VIS_NETWORK_URL);
    });

    it('ships a graph fallback so a blocked or mismatched script degrades with an explanation', () => {
        const html = renderDashboard(payloadOf());
        expect(html).toContain('graph-fallback');
        expect(html).toContain('typeof vis');
        const client = loadClient();
        const fallback = client.graphFallbackHtml(VIS_NETWORK_VERSION);
        expect(fallback).toContain('Graph view unavailable');
        expect(fallback).toContain(VIS_NETWORK_VERSION);
    });
});

describe('renderDashboard — HTML injection (D4)', () => {
    const hostilePayload = () => payloadOf({
        graph: { nodes: [node('src/evil.ts::' + XSS, XSS)], edges: [] },
        diff: diffOf({ addedNodes: [node('src/evil.ts::' + XSS, XSS)] }),
        confidence: {
            overallConfidence: 10,
            executionDepth: 0,
            unverifiedAssumptions: [XSS],
            explanation: [XSS],
        },
        plan: { targets: [], executionRecommendations: [XSS] },
    });

    it('renders a script-tag node label inert', () => {
        const html = renderDashboard(hostilePayload());
        expect(html).not.toContain('<script>alert(1)</script>');
        expect(html).toContain('&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
    });

    it('leaves exactly the page\'s own four script elements closed', () => {
        const html = renderDashboard(hostilePayload());
        // vis-network, payload JSON, config JSON, inlined runtime. A payload that
        // could close a block would push this count up.
        expect((html.match(/<\/script>/g) ?? [])).toHaveLength(4);
    });

    it('preserves the hostile label in the embedded payload, escaped rather than dropped', () => {
        const html = renderDashboard(hostilePayload());
        const embedded = embeddedJson(html, 'veris-payload');
        expect(embedded.graph.nodes[0].label).toBe(XSS);
        expect(embedded.confidence.unverifiedAssumptions[0]).toBe(XSS);
    });

    it('escapes assumptions, explanations and recommendations', () => {
        const html = renderDashboard(hostilePayload());
        const inertOccurrences = html.split('&lt;script&gt;alert(1)').length - 1;
        // added-node list (label + id), assumption, explanation, recommendation.
        expect(inertOccurrences).toBeGreaterThanOrEqual(4);
    });

    it('escapes a quote breakout attempt in an attribute-bearing field', () => {
        const html = renderDashboard(payloadOf({
            diff: diffOf({ addedNodes: [node('src/a.ts::' + ATTR_BREAKOUT, ATTR_BREAKOUT)] }),
        }));
        expect(html).not.toContain('onmouseover="alert(1)"');
        expect(html).toContain('onmouseover=&quot;alert(1)');
    });
});

describe('browser asset — HTML builders escape every source-derived field (D4)', () => {
    const client = loadClient();

    it('escapes workflow name, narrative and id on a workflow card', () => {
        const html = client.workflowCardHtml(
            {
                workflowId: ATTR_BREAKOUT,
                workflowName: XSS,
                narrative: XSS,
                memberCount: 2,
                impactedCount: 1,
                maxRisk: 70,
                runtimeRisks: [XSS],
            },
            { activeWorkflowId: null, signals: [{ source: 'path', value: XSS }] }
        );
        expect(html).not.toContain('<script>');
        expect(html).not.toContain('onmouseover="');
        expect(html).toContain('&lt;script&gt;alert(1)');
    });

    it('escapes plugin-supplied probe category and severity', () => {
        // `kind`, `category` and `severity` can come from a plugin, and severity
        // lands inside a class attribute — the site cited at ReportingEngine:818.
        const html = client.probeItemHtml({
            nodeId: 'src/a.ts::a',
            category: XSS,
            severity: ATTR_BREAKOUT,
            workflowKind: XSS,
            scenario: XSS,
            expectedInvariant: XSS,
        }, 0);
        expect(html).not.toContain('<script>');
        expect(html).not.toContain('onmouseover="');
        expect(html).toContain('severity-x&quot; onmouseover=&quot;alert(1)');
    });

    it('escapes tier and priority on a verification target row', () => {
        const html = client.targetRowHtml({
            nodeId: 'src/a.ts::a',
            tier: XSS,
            priority: ATTR_BREAKOUT,
            directive: XSS,
        }, 0);
        expect(html).not.toContain('<script>');
        expect(html).not.toContain('onmouseover="');
    });

    it('escapes node ids in risk rows, heat cells and drift items', () => {
        expect(client.riskRowHtml({ nodeId: XSS, score: { overallRisk: 10 } })).not.toContain('<script>');
        expect(client.heatCellHtml({ workflowId: XSS, workflowName: XSS, narrative: XSS, maxRisk: 10 })).not.toContain('<script>');
        expect(client.driftItemHtml({ narrative: XSS, changedSinceLastRun: true, memberChange: 0 })).not.toContain('<script>');
    });

    it('coerces a non-numeric score instead of interpolating it', () => {
        const html = client.riskRowHtml({ nodeId: 'a', score: { overallRisk: '<img src=x onerror=alert(1)>' } });
        expect(html).not.toContain('<img');
        expect(html).toContain('0.0');
    });
});

describe('browser asset — filters and caps', () => {
    const client = loadClient();

    it('filters probes by text, severity and active workflow', () => {
        const probes = [
            { nodeId: 'src/auth.ts::login', severity: 'high', workflowId: 'auth', workflowKind: 'Authentication' },
            { nodeId: 'src/cart.ts::add', severity: 'low', workflowId: 'cart', workflowKind: 'Cart' },
        ];
        expect(client.filterProbes(probes, { text: 'auth' })).toHaveLength(1);
        expect(client.filterProbes(probes, { severity: 'low' })).toHaveLength(1);
        expect(client.filterProbes(probes, { workflowId: 'cart' })).toHaveLength(1);
        expect(client.filterProbes(probes, {})).toHaveLength(2);
    });

    it('filters targets by tier, priority and workflow', () => {
        const targets = [
            { nodeId: 'src/a.ts::a', tier: 'Tier 1 - Structural Verification', priority: 'High' },
            { nodeId: 'src/b.ts::b', tier: 'Tier 3 - Adversarial Verification', priority: 'Low' },
        ];
        const workflowIdByNode = { 'src/a.ts::a': 'auth' };
        expect(client.filterTargets(targets, { tier: 'Tier 3' })).toHaveLength(1);
        expect(client.filterTargets(targets, { priority: 'High' })).toHaveLength(1);
        expect(client.filterTargets(targets, { workflowId: 'auth', workflowIdByNode })).toHaveLength(1);
    });

    it('sorts risks by the selected column', () => {
        const risks = [
            { nodeId: 'a', score: { overallRisk: 10, blastRadius: 90, dependencyFragility: 0, runtimeCriticality: 0 } },
            { nodeId: 'b', score: { overallRisk: 80, blastRadius: 1, dependencyFragility: 0, runtimeCriticality: 0 } },
        ];
        expect(client.filterRisks(risks, { sortBy: 'risk' })[0].nodeId).toBe('b');
        expect(client.filterRisks(risks, { sortBy: 'blast' })[0].nodeId).toBe('a');
    });

    it('caps rendered rows and reports how many are hidden', () => {
        const cap = client.capRows(Array.from({ length: 900 }, (_, i) => i), 500);
        expect(cap.visible).toHaveLength(500);
        expect(cap.shown).toBe(500);
        expect(cap.total).toBe(900);
        expect(client.capNoteHtml(cap, 'targets')).toContain('Showing 500 of 900 targets');
    });

    it('emits no cap note when everything is shown', () => {
        expect(client.capNoteHtml(client.capRows([1, 2], 500), 'targets')).toBe('');
    });
});

describe('browser asset — budget math matches the server allocator (G6)', () => {
    const client = loadClient();

    it('selects the same targets in the same order as VerificationBudgetAllocator', () => {
        const targets = [
            target('src/auth.ts::login', VerificationTier.Adversarial),
            target('src/cart.ts::add', VerificationTier.Structural),
            target('src/report.ts::render', VerificationTier.Behavioral),
            target('src/util.ts::noop', VerificationTier.Structural),
        ];
        const risks = [
            risk('src/auth.ts::login', 91),
            risk('src/cart.ts::add', 37),
            risk('src/report.ts::render', 58),
            risk('src/util.ts::noop', 12),
        ];
        const domains = [
            domain('authentication', WorkflowKind.Authentication, ['src/auth.ts::login']),
            domain('cart', WorkflowKind.Cart, ['src/cart.ts::add']),
            domain('reporting', WorkflowKind.Reporting, ['src/report.ts::render']),
        ];
        const minutes = 3;

        const server = new VerificationBudgetAllocator(PROJECT_ROOT)
            .allocate(plan(targets), risks, domains, minutes);

        const riskByNode: Record<string, number> = {};
        risks.forEach(r => { riskByNode[r.nodeId] = r.score.overallRisk; });
        const workflowByNode: Record<string, unknown> = {};
        domains.forEach(d => d.memberNodeIds.forEach(id => { workflowByNode[id] = d; }));

        const scored = client.scoreTargets(targets, {
            budget: loadRiskConfig(PROJECT_ROOT).budget,
            riskByNode,
            workflowByNode,
        });
        const picked = client.selectWithinBudget(scored, minutes * 60);

        expect(picked.selected.map((t: any) => t.nodeId)).toEqual(server.selected.map(t => t.nodeId));
        expect(picked.usedSec).toBe(server.totalEstimatedSec);
    });

    it('reads its constants from the page config rather than hardcoding them', () => {
        const html = renderDashboard(payloadOf());
        const config = embeddedJson(html, 'veris-config');
        expect(config.budget).toEqual(loadRiskConfig(PROJECT_ROOT).budget);

        const source = loadDashboardClientScript();
        // The old copy: TIER_LEVERAGE / TIER_COST / WF_CRIT literals in the asset.
        expect(source).not.toContain('TIER_LEVERAGE');
        expect(source).not.toContain('TIER_COST');
        expect(source).not.toContain('WF_CRIT');
    });
});

describe('renderDashboard — render ceiling (F1)', () => {
    it('caps embedded nodes and states the cap in the page', () => {
        const nodes = Array.from({ length: 50 }, (_, i) => node(`src/f${i}.ts::fn${i}`));
        const html = renderDashboard(payloadOf({ graph: { nodes, edges: [] } }), { limits: { maxNodes: 10 } });
        expect(html).toContain('Showing 10 of 50 nodes');
        const embedded = embeddedJson(html, 'veris-payload');
        expect(embedded.graph.nodes).toHaveLength(10);
        expect(embedded.render.truncated).toBe(true);
        expect(embedded.render.totalNodes).toBe(50);
    });

    it('states when nothing was capped', () => {
        const html = renderDashboard(payloadOf({ graph: { nodes: [node('a.ts::a')], edges: [] } }));
        expect(html).toContain('Showing all 1 nodes and 0 edges');
    });

    it('caps the added-node list', () => {
        const added = Array.from({ length: 30 }, (_, i) => node(`src/new${i}.ts::fn${i}`));
        const html = renderDashboard(payloadOf({ diff: diffOf({ addedNodes: added }) }), {
            limits: { maxAddedNodeRows: 5 },
        });
        expect(html).toContain('Showing 5 of 30 added nodes');
        // The rendered list stops at the cap; the embedded payload still carries
        // every added node, so the JSON export stays complete.
        expect((html.match(/class="added-node"/g) ?? [])).toHaveLength(5);
        expect(embeddedJson(html, 'veris-payload').diff.addedNodes).toHaveLength(30);
    });

    it('keeps a large repository\'s dashboard to a size a browser can open', () => {
        const nodes = Array.from({ length: 20000 }, (_, i) => node(`src/pkg${i % 50}/f${i}.ts::fn${i}`));
        const edges = Array.from({ length: 20000 }, (_, i) => ({
            sourceId: nodes[i].id,
            targetId: nodes[(i + 1) % nodes.length].id,
            type: 'INVOKES' as any,
        }));
        const html = renderDashboard(payloadOf({ graph: { nodes, edges } }));
        expect(html).toContain(`Showing ${DEFAULT_RENDER_LIMITS.maxNodes} of 20000 nodes`);
        expect(Buffer.byteLength(html, 'utf8')).toBeLessThan(2_000_000);
    });
});

describe('renderDashboard — payload contract', () => {
    it('stamps the schema version on the embedded payload', () => {
        const html = renderDashboard(payloadOf());
        expect(embeddedJson(html, 'veris-payload').schemaVersion).toBe(DASHBOARD_PAYLOAD_SCHEMA_VERSION);
    });

    it('does not mutate the caller\'s payload', () => {
        const payload = payloadOf({ graph: { nodes: [node('a.ts::a'), node('b.ts::b')], edges: [] } });
        renderDashboard(payload, { limits: { maxNodes: 1 } });
        expect(payload.graph.nodes).toHaveLength(2);
        expect(payload.render).toBeUndefined();
    });

    it('accepts an injected client script, keeping the template independent of the asset', () => {
        const html = renderDashboard(payloadOf(), { clientScript: '/* stub */' });
        expect(html).toContain('/* stub */');
    });
});

describe('loadDashboardClientScript', () => {
    it('finds the shipped asset and returns a runtime that exports its helpers', () => {
        const source = loadDashboardClientScript();
        expect(source.length).toBeGreaterThan(1000);
        expect(typeof loadClient().esc).toBe('function');
    });

    it('contains no script closing sequence, since it is inlined into one', () => {
        expect(/<\/script/i.test(loadDashboardClientScript())).toBe(false);
    });
});

describe('assembled page — template and asset agree', () => {
    it('parses the inlined runtime, so template assembly cannot ship broken JavaScript', () => {
        const html = renderDashboard(payloadOf({ graph: { nodes: [node('src/a.ts::a')], edges: [] } }));
        const inline = /<script>\n([\s\S]*?)\n<\/script>/.exec(html);
        expect(inline).not.toBeNull();
        expect(() => new Function('module', 'exports', inline![1])).not.toThrow();
    });

    it('renders every element id the browser runtime looks up', () => {
        const source = loadDashboardClientScript();
        const html = renderDashboard(payloadOf());
        const ids = new Set<string>();
        for (const m of source.matchAll(/(?:byId|getElementById|readEmbeddedJson)\('([^']+)'\)/g)) {
            ids.add(m[1]);
        }
        expect(ids.size).toBeGreaterThan(20);
        const missing = [...ids].filter(id => !html.includes(`id="${id}"`));
        expect(missing).toEqual([]);
    });
});

describe('assertInlinableScript', () => {
    it('rejects a script that would close its own element', () => {
        expect(() => assertInlinableScript('var x = 1;', 'asset.js')).not.toThrow();
        expect(() => assertInlinableScript('var s = "</scr" + "ipt>";'.replace('" + "', ''), 'asset.js'))
            .toThrow(/cannot be inlined/);
    });
});

describe('ReportingEngine file output', () => {
    it('writes the dashboard under <root>/veris-reports with the pinned script tag', () => {
        const root = makeTmpRoot();
        const engine = new ReportingEngine(root);
        const htmlPath = engine.generateDashboard(payloadOf({
            graph: { nodes: [node('src/a.ts::a')], edges: [] },
        }));
        expect(htmlPath).toBe(path.join(root, 'veris-reports', 'veris-dashboard.html'));
        const html = fs.readFileSync(htmlPath, 'utf8');
        expect(html).toContain(`integrity="${VIS_NETWORK_SRI}"`);
        expect(html).toContain(`vis-network@${VIS_NETWORK_VERSION}`);
    });

    it('writes the markdown report', () => {
        const root = makeTmpRoot();
        const engine = new ReportingEngine(root);
        const mdPath = engine.generateMarkdownReport(
            diffOf({ addedNodes: [node('src/a.ts::a')] }),
            [risk('src/a.ts::a', 80)],
            plan([target('src/a.ts::a', VerificationTier.Structural)]),
            { overallConfidence: 55, executionDepth: 20, unverifiedAssumptions: ['assume'], explanation: ['because'] },
            { diffMode: 'git', baseRef: 'main', headRef: 'HEAD' }
        );
        const md = fs.readFileSync(mdPath, 'utf8');
        expect(md).toContain('# Veris Executive Summary');
        expect(md).toContain('src/a.ts::a');
    });

    it('converts headings, lists and paragraphs', () => {
        const root = makeTmpRoot();
        const engine = new ReportingEngine(root);
        const htmlPath = engine.generateHtmlReport(
            ['# Title', '', '## Section', '', '### Sub', '', '#### Deep', '',
                '- one', '- two', '', 'A `code` and **bold** line.', ''].join('\n')
        );
        const html = fs.readFileSync(htmlPath, 'utf8');
        expect(html).toContain('<h1>Title</h1>');
        expect(html).toContain('<h2>Section</h2>');
        expect(html).toContain('<h3>Sub</h3>');
        expect(html).toContain('<h4>Deep</h4>');
        expect(html).toContain('<li>one</li>');
        expect(html).toContain('<code>code</code>');
        expect(html).toContain('<strong>bold</strong>');
    });

    it('escapes source-derived text when converting markdown to HTML', () => {
        const root = makeTmpRoot();
        const engine = new ReportingEngine(root);
        const htmlPath = engine.generateHtmlReport(`# Report\n\n- Node: ${XSS}\n`);
        const html = fs.readFileSync(htmlPath, 'utf8');
        expect(html).not.toContain('<script>alert(1)</script>');
        expect(html).toContain('&lt;script&gt;alert(1)');
    });
});
