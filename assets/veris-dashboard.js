/**
 * Veris dashboard — browser runtime.
 *
 * This file is inlined verbatim into the generated single-file dashboard by
 * src/reporting/ReportingEngine.ts. It lives here, and not inside a TypeScript
 * template literal, so it can use template literals itself, be read by an editor
 * or linter as JavaScript, and be unit-tested: under CommonJS it exports its pure
 * helpers and skips the DOM bootstrap, so tests/unit/ReportingEngine.test.ts can
 * exercise the HTML builders and the budget math without a browser.
 *
 * Two rules hold throughout:
 *  1. Every value originating in analyzed source, in a plugin, or in the embedded
 *     payload is written through `h` or `esc`. A repository can contain a class
 *     whose name is a script tag; concatenating such a name into markup is what
 *     let it reach the reader's DOM (finding D4).
 *  2. This file must never contain the closing-tag sequence for a script element:
 *     it is inlined into one and would terminate it early. The loader asserts it.
 */
(function (factory) {
    const api = factory();
    // Node (vitest): hand back the pure helpers, run nothing — there is no DOM.
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (typeof document !== 'undefined') api.boot();
})(function () {
    'use strict';

    // =====================================================================
    // Section 1 — escaping and formatting primitives
    // =====================================================================

    const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

    /** Escape a value for HTML text or a quoted attribute. null/undefined render empty. */
    function esc(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/[&<>"']/g, c => ESCAPES[c]);
    }

    /** Mark an already-built fragment so `h` inserts it without re-escaping. */
    function raw(html) { return { __raw: String(html) }; }

    /**
     * Tagged template that escapes every interpolated value. Composed fragments
     * must be wrapped in `raw()` to opt out, which keeps every unescaped
     * insertion greppable.
     */
    function h(strings, ...values) {
        let out = strings[0];
        for (let i = 0; i < values.length; i++) {
            const v = values[i];
            out += (v && typeof v === 'object' && '__raw' in v) ? v.__raw : esc(v);
            out += strings[i + 1];
        }
        return out;
    }

    /** Payloads cross process and file boundaries, so a field typed `number` can arrive as anything. */
    function num(value) {
        const n = Number(value);
        return Number.isFinite(n) ? n : 0;
    }

    function fixed(value, digits) { return num(value).toFixed(digits); }

    function str(value) { return value === null || value === undefined ? '' : String(value); }

    /** 'Tier 2 - Behavioral Verification' -> 'Tier 2'. */
    function tierKeyOf(tier) { return str(tier).split(' - ')[0]; }

    /** Node ids are project-root-relative POSIX paths; show the last two segments. */
    function shortId(id) { return str(id).split('/').slice(-2).join('/'); }

    // =====================================================================
    // Section 2 — pure data shaping (unit-tested under Node)
    // =====================================================================

    function filterProbes(probes, query) {
        const q = query || {};
        const text = str(q.text).toLowerCase();
        return (probes || []).filter(p =>
            (str(p.nodeId).toLowerCase().includes(text) || str(p.workflowKind).toLowerCase().includes(text)) &&
            (!q.severity || p.severity === q.severity) &&
            (!q.workflowId || p.workflowId === q.workflowId)
        );
    }

    function filterTargets(targets, query) {
        const q = query || {};
        const text = str(q.text).toLowerCase();
        const workflowIdByNode = q.workflowIdByNode || {};
        return (targets || []).filter(t =>
            str(t.nodeId).toLowerCase().includes(text) &&
            (!q.tier || str(t.tier).startsWith(q.tier)) &&
            (!q.priority || t.priority === q.priority) &&
            (!q.workflowId || workflowIdByNode[t.nodeId] === q.workflowId)
        );
    }

    function filterRisks(risks, query) {
        const q = query || {};
        const text = str(q.text).toLowerCase();
        const workflowIdByNode = q.workflowIdByNode || {};
        const sorters = {
            risk: (a, b) => num(b.score.overallRisk) - num(a.score.overallRisk),
            blast: (a, b) => num(b.score.blastRadius) - num(a.score.blastRadius),
            frag: (a, b) => num(b.score.dependencyFragility) - num(a.score.dependencyFragility),
            crit: (a, b) => num(b.score.runtimeCriticality) - num(a.score.runtimeCriticality)
        };
        return (risks || [])
            .filter(r =>
                str(r.nodeId).toLowerCase().includes(text) &&
                (!q.workflowId || workflowIdByNode[r.nodeId] === q.workflowId)
            )
            .sort(sorters[q.sortBy] || sorters.risk);
    }

    /**
     * Client-side re-run of the server's greedy allocator, so the budget input is
     * live. The constants arrive in the page config, which the generator reads
     * from data/risk-config.json — they used to be a second hardcoded copy here,
     * free to drift away from the allocator's (finding G6).
     */
    function scoreTargets(targets, ctx) {
        const c = ctx || {};
        const budget = c.budget || {};
        const leverage = budget.tierLeverage || {};
        const costs = budget.tierCostSeconds || {};
        const criticality = budget.workflowCriticality || {};
        const riskByNode = c.riskByNode || {};
        const workflowByNode = c.workflowByNode || {};
        return (targets || []).map(t => {
            const key = tierKeyOf(t.tier);
            const tierLeverage = num(leverage[key]) || 1;
            const cost = num(costs[key]) || 5;
            const risk = t.nodeId in riskByNode ? num(riskByNode[t.nodeId]) : 10;
            const wf = workflowByNode[t.nodeId];
            const crit = wf ? (num(criticality[wf.kind]) || 1) : 1;
            return Object.assign({}, t, {
                _score: (tierLeverage * crit * (risk / 10)) / cost,
                _cost: cost,
                _workflowName: wf ? wf.name : ''
            });
        }).sort((a, b) => b._score - a._score);
    }

    function selectWithinBudget(scored, budgetSec) {
        const selected = [];
        let usedSec = 0;
        for (const t of scored || []) {
            if (usedSec + t._cost <= budgetSec) { selected.push(t); usedSec += t._cost; }
        }
        return { selected, usedSec };
    }

    /**
     * Ceiling on rows handed to innerHTML. A monorepo produces tens of thousands
     * of targets; rendering every one of them is what makes the page unopenable
     * rather than merely large (finding F1).
     */
    function capRows(rows, maxRows) {
        const all = rows || [];
        const limit = Math.max(0, num(maxRows) || all.length);
        return { visible: all.slice(0, limit), shown: Math.min(all.length, limit), total: all.length };
    }

    // =====================================================================
    // Section 3 — HTML fragment builders (every interpolation escaped)
    // =====================================================================

    function capNoteHtml(cap, noun) {
        if (cap.shown >= cap.total) return '';
        return h`<div class="cap-note">Showing ${cap.shown} of ${cap.total} ${noun} — narrow the filters to reach the rest.</div>`;
    }

    function workflowCardHtml(w, ctx) {
        const c = ctx || {};
        const maxRisk = num(w.maxRisk);
        const riskCls = maxRisk >= 50 ? 'risk-high'
            : maxRisk >= 30 ? 'risk-med'
                : num(w.impactedCount) > 0 ? 'risk-low' : 'untouched';
        const activeCls = c.activeWorkflowId === w.workflowId ? ' is-active' : '';
        const signals = (c.signals || []).slice(0, 6).map(s => `${str(s.source)}:${str(s.value)}`).join(' • ');
        const risks = (w.runtimeRisks || []).slice(0, 3);
        const risksHtml = risks.length
            ? `<ul class="risks-list">${risks.map(r => h`<li>${r}</li>`).join('')}</ul>`
            : '';
        const signalsHtml = signals ? h`<div class="signals" title="Inference signals">${signals}</div>` : '';
        return h`<div class="workflow-card ${riskCls}${activeCls}" data-wf="${w.workflowId}">` +
            h`<h3>${w.workflowName}</h3>` +
            h`<div class="narr">${w.narrative}</div>` +
            '<div class="meta-row">' +
                h`<span>${num(w.memberCount)} nodes</span>` +
                h`<span style="color:var(--warn)">${num(w.impactedCount)} impacted</span>` +
                h`<span style="margin-left:auto" class="risk-num" title="Max risk">${fixed(maxRisk, 0)}</span>` +
            '</div>' +
            risksHtml + signalsHtml +
        '</div>';
    }

    function heatCellHtml(w) {
        const risk = num(w.maxRisk);
        const r = Math.min(255, Math.round(80 + (risk / 100) * 175));
        const g = Math.max(60, Math.round(220 - (risk / 100) * 160));
        const b = Math.max(60, Math.round(150 - (risk / 100) * 90));
        return h`<div class="heatcell" data-wf="${w.workflowId}" style="background:rgb(${r},${g},${b})" title="${w.narrative}">` +
            h`<div class="lbl">${w.workflowName}</div>` +
            h`<div class="v">${fixed(risk, 0)}</div>` +
        '</div>';
    }

    // Key off driftClass, which the detector already computed, rather than
    // re-deriving severity from memberChange. A removed workflow has a negative
    // memberChange, so the old derivation styled the most severe class — a workflow
    // that vanished — with the mildest "changed" treatment.
    const DRIFT_CLASS_STYLE = {
        'removed': 'removed',
        'silent-rewrite': 'silent',
        'surface-contraction': 'changed',
        'surface-expansion': 'changed',
        'first-observation': 'baseline',
        'stable': ''
    };

    function driftItemHtml(d) {
        const cls = d.oscillationDetected
            ? 'oscillating'
            : (DRIFT_CLASS_STYLE[d.driftClass] !== undefined
                ? DRIFT_CLASS_STYLE[d.driftClass]
                : (d.changedSinceLastRun ? 'changed' : ''));
        return h`<div class="drift-item ${cls}">${d.narrative}</div>`;
    }

    function probeItemHtml(p, index) {
        const kindHtml = p.workflowKind ? h` <span class="cat">${p.workflowKind}</span>` : '';
        return h`<div class="probe-item severity-${p.severity}">` +
            h`<div><span class="cat">${p.category}</span><span class="cat">${p.severity}</span>` +
            h`<span class="node-id">${shortId(p.nodeId)}</span>` +
            kindHtml +
            h`<button class="copy-btn" data-i="${index}" style="float:right">Copy</button></div>` +
            h`<div class="scen">${p.scenario}</div>` +
            h`<div class="inv">Expected invariant: ${p.expectedInvariant}</div>` +
        '</div>';
    }

    function riskRowHtml(r) {
        const s = r.score || {};
        const overall = num(s.overallRisk);
        const cls = overall >= 50 ? 'high' : overall >= 30 ? 'med' : 'low';
        return h`<tr><td class="id" title="${r.nodeId}">${shortId(r.nodeId)}</td>` +
            h`<td><span class="pill ${cls}">${fixed(overall, 1)}</span></td>` +
            h`<td>${num(s.blastRadius)}</td>` +
            h`<td>${num(s.runtimeCriticality)}</td>` +
            h`<td>${num(s.dependencyFragility)}</td>` +
            h`<td>${num(s.integrationCount)}</td></tr>`;
    }

    function targetRowHtml(t, index) {
        const tier = str(t.tier);
        const tierCls = tier.startsWith('Tier 1') ? 't1' : tier.startsWith('Tier 2') ? 't2' : 't3';
        const priCls = t.priority === 'High' ? 'high' : t.priority === 'Medium' ? 'med' : 'low';
        return '<details><summary class="target-summary">' +
            h`<span><span class="pill ${tierCls}">${tierKeyOf(tier)}</span> ` +
            h`<span class="pill ${priCls}">${t.priority}</span> ` +
            h`<span class="node-id">${shortId(t.nodeId)}</span></span>` +
            h`<button class="copy-btn" data-i="${index}">Copy directive</button>` +
            '</summary>' +
            h`<div class="explain" style="margin-top:8px">${t.directive}</div>` +
        '</details>';
    }

    function budgetRowHtml(t) {
        const key = tierKeyOf(t.tier);
        const cls = key === 'Tier 1' ? 't1' : key === 'Tier 2' ? 't2' : 't3';
        return '<div class="budget-row">' +
            h`<span class="badge-tier ${cls}">${key}</span>` +
            h`<span class="node-id ellipsis" title="${t.nodeId}">${shortId(t.nodeId)}</span>` +
            h`<span style="color:var(--muted)">${t._workflowName || '-'}</span>` +
            h`<span style="text-align:right;color:var(--muted)">${num(t._cost)}s</span>` +
        '</div>';
    }

    function graphFallbackHtml(version) {
        return '<div class="graph-fallback"><strong>Graph view unavailable.</strong>' +
            h`<div>The vis-network library (pinned to ${version || 'an exact version'}, verified with a Subresource Integrity hash) did not load. ` +
            'That happens offline, when the CDN is blocked, or when the served file does not match the pinned hash — ' +
            'in which case the browser refuses it on purpose.</div>' +
            '<div>Every other panel on this page is rendered from the embedded payload and works without it.</div>' +
        '</div>';
    }

    // =====================================================================
    // Section 4 — DOM bootstrap
    // =====================================================================

    function readEmbeddedJson(id) {
        const el = document.getElementById(id);
        if (!el) return null;
        try {
            return JSON.parse(el.textContent || 'null');
        } catch (err) {
            console.error('veris: could not parse embedded JSON block ' + id, err);
            return null;
        }
    }

    function boot() {
        const PAYLOAD = readEmbeddedJson('veris-payload') || {};
        const CONFIG = readEmbeddedJson('veris-config') || {};
        const LIMITS = (CONFIG.render && CONFIG.render.limits) || {};
        const MAX_ROWS = num(LIMITS.maxRows) || 500;

        const byId = id => document.getElementById(id);

        // ---- indexes -------------------------------------------------
        const WORKFLOWS = (PAYLOAD.workflows && PAYLOAD.workflows.aggregates) || [];
        const WF_DOMAINS = (PAYLOAD.workflows && PAYLOAD.workflows.workflows) || [];
        const workflowByNode = {};
        const workflowIdByNode = {};
        WF_DOMAINS.forEach(d => (d.memberNodeIds || []).forEach(id => {
            workflowByNode[id] = d;
            workflowIdByNode[id] = d.id;
        }));
        const riskByNode = {};
        (PAYLOAD.risks || []).forEach(r => { riskByNode[r.nodeId] = num(r.score && r.score.overallRisk); });
        const addedSet = new Set(((PAYLOAD.diff && PAYLOAD.diff.addedNodes) || []).map(n => n.id));
        let activeWorkflowFilter = null;

        // ---- header --------------------------------------------------
        const meta = PAYLOAD.meta || {};
        byId('metaLine').textContent =
            'Diff mode: ' + (meta.diffMode || 'n/a') +
            (meta.baseRef ? ' • base: ' + meta.baseRef : '') +
            (meta.headRef ? ' • head: ' + str(meta.headRef).substring(0, 7) : '') +
            (meta.projectRoot ? ' • ' + meta.projectRoot : '');

        (function renderGenTime() {
            const generatedAt = meta.generatedAt || '';
            const el = byId('genTime');
            if (!generatedAt) { el.textContent = ''; return; }
            const d = new Date(generatedAt);
            if (isNaN(d.getTime())) { el.textContent = str(generatedAt).replace('T', ' ').replace(/\..+/, ''); return; }
            // Viewer's machine locale + timezone; falls back to UTC if Intl is unavailable.
            try {
                const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';
                const fmt = new Intl.DateTimeFormat(undefined, {
                    year: 'numeric', month: 'short', day: '2-digit',
                    hour: '2-digit', minute: '2-digit', second: '2-digit',
                    timeZoneName: 'short'
                });
                el.textContent = fmt.format(d);
                el.title = 'Source (UTC): ' + generatedAt + ' • Timezone: ' + tz;
            } catch {
                el.textContent = d.toISOString().replace('T', ' ').replace(/\..+/, '') + ' UTC';
            }
        })();

        // ---- executive summary ---------------------------------------
        (function buildHero() {
            const conf = num(PAYLOAD.confidence && PAYLOAD.confidence.overallConfidence);
            const drift = PAYLOAD.drift || {};
            const highRiskWF = WORKFLOWS.filter(w => num(w.maxRisk) >= 50);
            const probes = (PAYLOAD.probes || []).filter(p => p.severity === 'high').length;
            const trend = PAYLOAD.confidenceTrend || [];
            const trendDelta = trend.length >= 2
                ? num(trend[0].overallConfidence) - num(trend[trend.length - 1].overallConfidence)
                : 0;

            const verdict = conf >= 70 ? 'Healthy.' : conf >= 40 ? 'Caution.' : 'High risk.';
            const verdictColor = conf >= 70 ? 'var(--ok)' : conf >= 40 ? 'var(--warn)' : 'var(--danger)';
            const parts = [];
            parts.push(h`<strong style="color:${verdictColor}">${verdict}</strong> Confidence ${fixed(conf, 0)}/100` +
                (trend.length >= 2 ? h` (${(trendDelta >= 0 ? '+' : '') + fixed(trendDelta, 0)} vs first recorded run)` : '') + '.');
            if (highRiskWF.length) {
                const names = highRiskWF.slice(0, 3).map(w => esc(w.workflowName)).join(', ');
                parts.push(h`${highRiskWF.length} workflow${highRiskWF.length === 1 ? '' : 's'} at elevated risk: ` +
                    `<em>${names}${highRiskWF.length > 3 ? ', ...' : ''}</em>.`);
            }
            if (drift.summary) parts.push(esc(drift.summary));
            if (probes) parts.push(h`${probes} high-severity adversarial probe${probes === 1 ? '' : 's'} generated.`);
            parts.push('Read Affected Behaviors below, then jump to Adversarial Probes to copy directives for autonomous execution.');
            byId('heroBody').innerHTML = parts.join(' ');
        })();

        // ---- exports -------------------------------------------------
        function downloadBlob(filename, blob) {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        }
        byId('exportJsonBtn').addEventListener('click', () => {
            downloadBlob('veris-dashboard-payload.json',
                new Blob([JSON.stringify(PAYLOAD, null, 2)], { type: 'application/json' }));
        });
        byId('exportCsvBtn').addEventListener('click', () => {
            const rows = [['type', 'workflow', 'tier', 'nodeId', 'field', 'value']];
            ((PAYLOAD.plan && PAYLOAD.plan.targets) || []).forEach(t =>
                rows.push(['target', workflowIdByNode[t.nodeId] || '', t.tier, t.nodeId, 'directive', t.directive]));
            (PAYLOAD.probes || []).forEach(p =>
                rows.push(['probe', p.workflowKind || '', p.category || '', p.nodeId, 'scenario', p.scenario]));
            (PAYLOAD.risks || []).forEach(r =>
                rows.push(['risk', workflowIdByNode[r.nodeId] || '', '', r.nodeId, 'overallRisk', String(num(r.score && r.score.overallRisk))]));
            const csv = rows.map(row => row.map(c => '"' + str(c).replace(/"/g, '""') + '"').join(',')).join('\n');
            downloadBlob('veris-export.csv', new Blob([csv], { type: 'text/csv' }));
        });

        // ---- graph ---------------------------------------------------
        const wfColorPalette = ['#5b8def', '#9b89ff', '#6ad7c1', '#ffb347', '#c897f0', '#ff8da1',
            '#62c9ff', '#a8e6cf', '#ffd966', '#f6a6b2', '#7ed6df', '#dcd6f7'];
        const workflowColors = {};
        WF_DOMAINS.forEach((d, i) => { workflowColors[d.id] = wfColorPalette[i % wfColorPalette.length]; });
        const nodeTypeColorFallback = { 0: '#5b8def', 1: '#ffb347', 2: '#9b89ff', 3: '#6ad7c1', 4: '#c897f0' };

        const graphEl = byId('graph');
        // The library is a pinned, integrity-checked third-party file, so it can
        // legitimately fail to load. Everything else on the page renders from the
        // embedded payload; only the graph degrades, and it says why.
        const visReady = typeof vis !== 'undefined' && vis &&
            typeof vis.Network === 'function' && typeof vis.DataSet === 'function';
        let nodeDataSet = null;

        if (graphEl && visReady) {
            const visNodes = ((PAYLOAD.graph && PAYLOAD.graph.nodes) || []).map(n => {
                const wfId = workflowIdByNode[n.id];
                const color = (wfId && workflowColors[wfId]) || nodeTypeColorFallback[n.type] || '#9b89ff';
                const risk = riskByNode[n.id];
                let borderColor = color;
                if (risk !== undefined && risk >= 50) borderColor = '#ff5d6c';
                if (addedSet.has(n.id)) borderColor = '#ffb347';
                const wfName = workflowByNode[n.id] ? workflowByNode[n.id].name : null;
                return {
                    id: n.id,
                    label: n.label,
                    title: n.id +
                        (wfName ? '\nWorkflow: ' + wfName : '') +
                        (risk !== undefined ? '\nRisk: ' + fixed(risk, 1) : ''),
                    color: { background: color, border: borderColor, highlight: { background: color, border: '#fff' } },
                    size: risk !== undefined ? 12 + Math.min(risk / 4, 18) : 10,
                    font: { color: '#e6e8ec', size: 11 },
                    borderWidth: borderColor === color ? 1 : 3,
                    shape: 'dot',
                    _wf: wfId
                };
            });
            const edgeTypeColor = { INVOKES: '#5b8def', DEPENDS_ON: '#3a3f4a', MUTATES: '#ff5d6c', SYNCHRONIZES: '#ffb347' };
            const visEdges = ((PAYLOAD.graph && PAYLOAD.graph.edges) || []).map((e, i) => ({
                id: i,
                from: e.sourceId,
                to: e.targetId,
                arrows: 'to',
                color: { color: edgeTypeColor[e.type] || '#3a3f4a', opacity: 0.5 },
                width: e.type === 'INVOKES' ? 1.5 : 1
            }));
            nodeDataSet = new vis.DataSet(visNodes);
            new vis.Network(
                graphEl,
                { nodes: nodeDataSet, edges: new vis.DataSet(visEdges) },
                {
                    physics: { stabilization: { iterations: 120 }, barnesHut: { gravitationalConstant: -8000, springLength: 120 } },
                    interaction: { hover: true, tooltipDelay: 100 },
                    layout: { improvedLayout: true }
                }
            );
        } else if (graphEl) {
            graphEl.innerHTML = graphFallbackHtml(CONFIG.visNetworkVersion);
        }

        // ---- workflow cards + cross-panel filter ----------------------
        function renderWorkflows() {
            const grid = byId('workflowGrid');
            if (!grid) return;
            if (WORKFLOWS.length === 0) { grid.innerHTML = '<div class="explain">No workflows classified.</div>'; return; }
            grid.innerHTML = WORKFLOWS.map(w => {
                const domain = WF_DOMAINS.find(d => d.id === w.workflowId);
                return workflowCardHtml(w, {
                    activeWorkflowId: activeWorkflowFilter,
                    signals: (domain && domain.signals) || []
                });
            }).join('');
            grid.querySelectorAll('.workflow-card').forEach(card => {
                card.addEventListener('click', () => toggleWorkflowFilter(card.dataset.wf));
            });
        }

        function toggleWorkflowFilter(wfId) {
            activeWorkflowFilter = (activeWorkflowFilter === wfId) ? null : wfId;
            applyWorkflowFilter();
            renderWorkflows();
        }

        function applyWorkflowFilter() {
            const label = byId('graphFilterLabel');
            const banner = byId('filterBanner');
            const bannerName = byId('filterBannerName');
            if (activeWorkflowFilter) {
                const wf = WORKFLOWS.find(w => w.workflowId === activeWorkflowFilter);
                const name = wf ? wf.workflowName : activeWorkflowFilter;
                label.textContent = '— filtered to: ' + name;
                bannerName.textContent = name;
                banner.classList.add('active');
                if (nodeDataSet) {
                    nodeDataSet.forEach(n => nodeDataSet.update({ id: n.id, hidden: n._wf !== activeWorkflowFilter }));
                }
            } else {
                label.textContent = '';
                banner.classList.remove('active');
                if (nodeDataSet) nodeDataSet.forEach(n => nodeDataSet.update({ id: n.id, hidden: false }));
            }
            renderRisks();
            renderTargets();
            renderProbes();
        }

        byId('clearFilterBtn').addEventListener('click', () => {
            activeWorkflowFilter = null;
            applyWorkflowFilter();
            renderWorkflows();
        });
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape' && activeWorkflowFilter) {
                activeWorkflowFilter = null;
                applyWorkflowFilter();
                renderWorkflows();
            }
        });

        // ---- heatmap -------------------------------------------------
        function renderHeatmap() {
            const el = byId('heatmap');
            if (!el) return;
            if (WORKFLOWS.length === 0) { el.innerHTML = '<div class="explain">No workflows.</div>'; return; }
            el.innerHTML = WORKFLOWS.map(heatCellHtml).join('');
            el.querySelectorAll('.heatcell').forEach(cell => {
                cell.addEventListener('click', () => toggleWorkflowFilter(cell.dataset.wf));
            });
        }

        // ---- confidence trend ----------------------------------------
        function renderTrend() {
            const svg = byId('trendChart');
            if (!svg) return;
            const trend = (PAYLOAD.confidenceTrend || []).slice().reverse(); // oldest -> newest
            const note = byId('trendNote');
            if (trend.length < 2) {
                svg.innerHTML = '<text x="10" y="60" fill="#9aa3b2" font-size="12">Need more than one run to chart. Run again to see the trend.</text>';
                note.textContent = trend.length === 1 ? '1 run on record.' : 'No history yet.';
                return;
            }
            const W = 400, H = 120, pad = 8;
            const step = (W - pad * 2) / (trend.length - 1);
            const points = trend.map((r, i) =>
                (pad + i * step) + ',' + (H - pad - (num(r.overallConfidence) / 100) * (H - pad * 2))
            ).join(' ');
            const first = num(trend[0].overallConfidence);
            const last = num(trend[trend.length - 1].overallConfidence);
            svg.innerHTML =
                h`<polyline points="${points}" fill="none" stroke="#4f8cff" stroke-width="2"/>` +
                `<line x1="0" y1="${H - pad}" x2="${W}" y2="${H - pad}" stroke="#2a2f3a"/>`;
            note.textContent = 'Trend over ' + trend.length + ' runs — last ' + last.toFixed(1) +
                ', first ' + first.toFixed(1) + ' (delta ' + (last - first).toFixed(1) + ').';
        }

        // ---- drift ---------------------------------------------------
        function renderDrift() {
            const summary = byId('driftSummary');
            const list = byId('driftList');
            const drift = PAYLOAD.drift;
            if (!drift || !drift.workflows || drift.workflows.length === 0) {
                summary.textContent = 'No drift data yet (first run on record).';
                list.innerHTML = '';
                return;
            }
            summary.textContent = drift.summary;
            list.innerHTML = drift.workflows.map(driftItemHtml).join('');
        }

        // ---- adversarial probes --------------------------------------
        function probeQuery() {
            return {
                text: byId('probeFilter').value || '',
                severity: byId('probeSeverity').value,
                workflowId: activeWorkflowFilter
            };
        }
        function renderProbes() {
            const list = byId('probeList');
            const filtered = filterProbes(PAYLOAD.probes || [], probeQuery());
            const cap = capRows(filtered, MAX_ROWS);
            list.innerHTML = (cap.visible.map(probeItemHtml).join('') || '<div class="explain">No probes match.</div>') +
                capNoteHtml(cap, 'probes');
            list.querySelectorAll('.copy-btn').forEach(btn => {
                btn.addEventListener('click', e => {
                    e.preventDefault();
                    const p = cap.visible[parseInt(btn.dataset.i, 10)];
                    copyToClipboard(
                        'Veris adversarial probe [' + p.severity + ' / ' + p.category + '] for ' + p.nodeId + ':\n' +
                        'Scenario: ' + p.scenario + '\n' +
                        'Expected invariant: ' + p.expectedInvariant + '\n\n' +
                        'Please design and execute a test that exercises this scenario, then report whether the invariant holds.',
                        btn
                    );
                });
            });
        }
        byId('probeFilter').addEventListener('input', renderProbes);
        byId('probeSeverity').addEventListener('change', renderProbes);
        byId('copyAllProbes').addEventListener('click', () => {
            const filtered = filterProbes(PAYLOAD.probes || [], probeQuery());
            copyToClipboard(
                'Veris adversarial probe batch (' + filtered.length + '):\n\n' +
                filtered.map((p, i) =>
                    (i + 1) + '. [' + p.severity + '/' + p.category + '] ' + p.nodeId +
                    '\n   Scenario: ' + p.scenario +
                    '\n   Invariant: ' + p.expectedInvariant
                ).join('\n\n') +
                '\n\nPlease design tests for each and report which invariants hold.',
                byId('copyAllProbes')
            );
        });

        // ---- budget allocator ----------------------------------------
        function renderBudget() {
            const minutes = parseInt(byId('budgetInput').value, 10) || 15;
            const scored = scoreTargets((PAYLOAD.plan && PAYLOAD.plan.targets) || [], {
                budget: CONFIG.budget,
                riskByNode,
                workflowByNode
            });
            const picked = selectWithinBudget(scored, minutes * 60);
            byId('budgetNarrative').textContent =
                'Selected ' + picked.selected.length + ' of ' + scored.length + ' targets, estimated ' +
                Math.round(picked.usedSec / 60) + '/' + minutes + ' min.';
            const cap = capRows(picked.selected, MAX_ROWS);
            byId('budgetList').innerHTML = cap.visible.map(budgetRowHtml).join('') + capNoteHtml(cap, 'selected targets');
        }
        byId('recomputeBudget').addEventListener('click', renderBudget);
        byId('budgetInput').addEventListener('change', renderBudget);
        byId('copyBudgetPrompt').addEventListener('click', () => {
            const minutes = parseInt(byId('budgetInput').value, 10) || 15;
            const lines = [];
            document.querySelectorAll('#budgetList .budget-row').forEach((row, i) => {
                lines.push((i + 1) + '. ' + row.children[1].textContent);
            });
            copyToClipboard(
                'Veris ' + minutes + '-minute verification plan (highest-leverage subset):\n\n' + lines.join('\n') +
                '\n\nPlease execute these in order, then report which passed and which failed via mcp__veris__report_execution.',
                byId('copyBudgetPrompt')
            );
        });

        // ---- risk table ----------------------------------------------
        function renderRisks() {
            const filtered = filterRisks(PAYLOAD.risks || [], {
                text: byId('riskFilter').value,
                sortBy: byId('riskSort').value,
                workflowId: activeWorkflowFilter,
                workflowIdByNode
            });
            const cap = capRows(filtered, MAX_ROWS);
            byId('riskBody').innerHTML = cap.visible.map(riskRowHtml).join('');
            byId('riskCapNote').innerHTML = capNoteHtml(cap, 'risk rows');
        }
        byId('riskFilter').addEventListener('input', renderRisks);
        byId('riskSort').addEventListener('change', renderRisks);

        // ---- verification targets ------------------------------------
        function targetQuery() {
            return {
                text: byId('targetFilter').value,
                tier: byId('tierFilter').value,
                priority: byId('priFilter').value,
                workflowId: activeWorkflowFilter,
                workflowIdByNode
            };
        }
        function renderTargets() {
            const list = byId('targetList');
            const filtered = filterTargets((PAYLOAD.plan && PAYLOAD.plan.targets) || [], targetQuery());
            const cap = capRows(filtered, MAX_ROWS);
            list.innerHTML = (cap.visible.map(targetRowHtml).join('') || '<div class="explain">No matching targets.</div>') +
                capNoteHtml(cap, 'targets');
            list.querySelectorAll('.copy-btn').forEach(btn => {
                btn.addEventListener('click', e => {
                    e.preventDefault();
                    const t = cap.visible[parseInt(btn.dataset.i, 10)];
                    copyToClipboard(
                        'Veris verification directive (' + t.tier + ', ' + t.priority + ' priority):\n' +
                        'Node: ' + t.nodeId + '\n' +
                        'Directive: ' + t.directive + '\n\n' +
                        'Please execute or plan execution for this directive.',
                        btn
                    );
                });
            });
        }
        byId('targetFilter').addEventListener('input', renderTargets);
        byId('tierFilter').addEventListener('change', renderTargets);
        byId('priFilter').addEventListener('change', renderTargets);
        byId('copyAll').addEventListener('click', () => {
            const filtered = filterTargets((PAYLOAD.plan && PAYLOAD.plan.targets) || [], targetQuery());
            copyToClipboard(
                'Veris verification batch (' + filtered.length + ' directives):\n\n' +
                filtered.map((t, i) => (i + 1) + '. [' + t.tier + ' / ' + t.priority + '] ' + t.nodeId + '\n   -> ' + t.directive).join('\n\n') +
                '\n\nPlease execute these in order and report results.',
                byId('copyAll')
            );
        });

        // ---- clipboard ------------------------------------------------
        function copyToClipboard(text, btn) {
            navigator.clipboard.writeText(text).then(() => {
                const original = btn.textContent;
                btn.textContent = '✓ Copied';
                btn.classList.add('done');
                showToast();
                setTimeout(() => { btn.textContent = original; btn.classList.remove('done'); }, 1500);
            }).catch(err => {
                alert('Clipboard failed: ' + err);
            });
        }
        function showToast() {
            const t = byId('toast');
            t.classList.add('show');
            setTimeout(() => t.classList.remove('show'), 1500);
        }

        renderWorkflows();
        renderHeatmap();
        renderTrend();
        renderDrift();
        renderProbes();
        renderBudget();
        renderRisks();
        renderTargets();
    }

    return {
        esc, raw, h, num, fixed, str, shortId, tierKeyOf,
        filterProbes, filterTargets, filterRisks, scoreTargets, selectWithinBudget, capRows,
        capNoteHtml, workflowCardHtml, heatCellHtml, driftItemHtml, probeItemHtml,
        riskRowHtml, targetRowHtml, budgetRowHtml, graphFallbackHtml,
        boot
    };
});
