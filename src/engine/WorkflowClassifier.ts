import { RepositoryIntelligenceReport } from '../models/EntityModels';
import { BehavioralGraph, GraphNode } from '../models/GraphModels';
import { DiffReport } from '../models/RiskModels';
import { RiskReport } from '../models/RiskModels';
import {
    WorkflowDomain, WorkflowKind, WorkflowSignal,
    WorkflowReport, WorkflowRiskAggregate
} from '../models/WorkflowModels';
import { ExternalWorkflowRule } from '../plugins/PluginLoader';
import { loadWorkflowRules, loadRuntimeRisks, WorkflowRuleData, RuntimeRiskData } from '../data/DataLoader';

interface Rule {
    kind: string;
    pathTokens?: string[];
    importTokens?: string[];
    symbolTokens?: string[];
    weight?: number;
}

export class WorkflowClassifier {
    private extraRules: Rule[] = [];
    private extraRiskTexts: Record<string, string[]> = {};
    private projectRoot: string;

    constructor(projectRoot: string = process.cwd()) {
        this.projectRoot = projectRoot;
    }

    public ingestPluginRules(rules: ExternalWorkflowRule[]): void {
        for (const r of rules) {
            this.extraRules.push({
                kind: r.kind,
                pathTokens: r.pathTokens,
                importTokens: r.importTokens,
                symbolTokens: r.symbolTokens,
                weight: r.weight
            });
        }
    }

    public ingestExtraRuntimeRisks(extra: Record<string, string[]>): void {
        for (const k of Object.keys(extra)) {
            this.extraRiskTexts[k] = (this.extraRiskTexts[k] || []).concat(extra[k]);
        }
    }

    public classify(
        report: RepositoryIntelligenceReport,
        graph: BehavioralGraph
    ): WorkflowDomain[] {
        const baseRules: WorkflowRuleData[] = loadWorkflowRules(this.projectRoot);
        const allRules: Rule[] = baseRules.concat(this.extraRules);

        const nodeKindVotes: Map<string, Map<string, { score: number; signals: WorkflowSignal[] }>> = new Map();

        const addVote = (nodeId: string, kind: string, signal: WorkflowSignal) => {
            let kindMap = nodeKindVotes.get(nodeId);
            if (!kindMap) { kindMap = new Map(); nodeKindVotes.set(nodeId, kindMap); }
            let entry = kindMap.get(kind);
            if (!entry) { entry = { score: 0, signals: [] }; kindMap.set(kind, entry); }
            entry.score += signal.weight;
            entry.signals.push(signal);
        };

        const allNodes = graph.getNodes();
        const nodeById = new Map(allNodes.map(n => [n.id, n]));

        for (const file of report.files) {
            const filePathLower = file.filePath.toLowerCase();
            const pathSegments = filePathLower.split(/[\\\/]/).filter(s => s.length > 0);
            const anchorIdx = pathSegments.findIndex(s => s === 'src' || s === 'lib' || s === 'app' || s === 'packages' || s === 'apps' || s === 'test-project');
            const relevantSegments = anchorIdx >= 0 ? pathSegments.slice(anchorIdx + 1) : pathSegments.slice(-4);
            const segmentSet = new Set(relevantSegments);
            const segmentBareSet = new Set([...segmentSet].map(s => s.replace(/\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs)$/i, '')));
            const fileImportsLower = (file.imports || []).map(i => i.toLowerCase());

            // Deweight test/sample/example/fixture code. These dirs naturally contain
            // tokens like "payment", "order", "auth" because they exercise real code,
            // but they are not the workflow itself — they are test harness. Signal
            // strength reduced to 30% so a real `src/auth/login.ts` always outranks
            // `__tests__/auth.test.ts` in scoring.
            //
            // Match only against the segments *after* the source anchor (relevantSegments).
            // If the user pointed Veris at a directory named "examples/demo-app", every
            // file would deweight by 0.3, which is wrong — that's the project root,
            // not test code inside it.
            const testishSegments = new Set([
                '__tests__', '__test__', 'tests', 'test', 'spec', 'specs',
                'sample', 'samples', 'example', 'examples', 'fixture', 'fixtures',
                'e2e', 'integration-tests', '__mocks__', '__fixtures__', 'benchmarks',
                'benchmark', 'bench'
            ]);
            const isTestish = relevantSegments.some(s => testishSegments.has(s))
                || /\.(test|spec)\.[a-z]+$/.test(filePathLower);
            const contextMultiplier = isTestish ? 0.3 : 1;

            // Returns match strength:
            //   'exact'  — path token is a literal directory segment (auth/, payments/) → strongest.
            //   'prefix' — segment starts with the token + ≤4 chars (auth → authn).
            //   'scoped' — scoped token like "app/api" found in joined path.
            // Returning null = no match.
            const matchesPathToken = (tok: string): 'exact' | 'prefix' | 'scoped' | null => {
                if (segmentSet.has(tok) || segmentBareSet.has(tok)) return 'exact';
                for (const seg of segmentBareSet) {
                    if (seg.startsWith(tok) && seg.length > tok.length) {
                        const rest = seg.slice(tok.length);
                        if (rest.length <= 4 && /^[a-z]+$/.test(rest)) return 'prefix';
                    }
                }
                if (tok.includes('/')) {
                    const scoped = relevantSegments.join('/');
                    if (scoped.includes(tok)) return 'scoped';
                }
                return null;
            };

            // Weighting rationale: a directory-segment match is the strongest possible
            // signal about which workflow a file belongs to — `src/payments/charge.ts`
            // is Payments regardless of which libs it imports. Imports come second
            // because they identify the *capability* (e.g., `import ioredis` shows
            // caching infra) but a file can use redis for sessions, rate-limiting,
            // queues, etc. Symbol-name votes are last because they are noisy
            // (`PaymentReconciler` lives in `src/index.js`, but the file is wiring,
            // not the Payments workflow).
            const fileSignals: { kind: string; signal: WorkflowSignal }[] = [];
            for (const rule of allRules) {
                const weight = rule.weight ?? 1;
                for (const tok of rule.pathTokens || []) {
                    const m = matchesPathToken(tok);
                    if (!m) continue;
                    const pathWeight = m === 'exact' ? 6 : m === 'prefix' ? 3 : 2;
                    fileSignals.push({ kind: rule.kind, signal: { source: 'path', value: tok, weight: weight * pathWeight * contextMultiplier } });
                }
                for (const tok of rule.importTokens || []) {
                    if (fileImportsLower.some(imp => imp.includes(tok))) {
                        fileSignals.push({ kind: rule.kind, signal: { source: 'import', value: tok, weight: weight * 3 * contextMultiplier } });
                    }
                }
            }

            const matchesSymbol = (name: string, tok: string): boolean => {
                const lower = name.toLowerCase();
                if (lower === tok) return true;
                // Word-boundary first (e.g., process_payment, processPayment2).
                const reBoundary = new RegExp('(^|[^a-z0-9])' + tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^a-z0-9])', 'i');
                if (reBoundary.test(name)) return true;
                // CamelCase boundary: split by case transitions and try again.
                // `issueSession` → ["issue","session"], so token `session` matches as a whole component.
                const camelParts = name
                    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
                    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
                    .toLowerCase()
                    .split(/[\s_]+/);
                return camelParts.includes(tok);
            };
            const symbolVotes: { symbolKey: string; kind: string; signal: WorkflowSignal }[] = [];
            const checkSymbol = (name: string, symbolKey: string) => {
                for (const rule of allRules) {
                    const weight = rule.weight ?? 1;
                    for (const tok of rule.symbolTokens || []) {
                        if (matchesSymbol(name, tok)) {
                            symbolVotes.push({ symbolKey, kind: rule.kind, signal: { source: 'symbol', value: tok, weight: weight * contextMultiplier } });
                        }
                    }
                }
            };

            for (const cls of file.classes) {
                checkSymbol(cls.name, `${file.filePath}::${cls.name}`);
                for (const m of cls.methods) {
                    checkSymbol(m.name, `${file.filePath}::${cls.name}::${m.name}`);
                }
            }
            for (const fn of file.functions) {
                checkSymbol(fn.name, `${file.filePath}::${fn.name}`);
            }

            const fileNodes = allNodes.filter(n => n.id.startsWith(file.filePath + '::'));
            for (const { kind, signal } of fileSignals) {
                for (const node of fileNodes) addVote(node.id, kind, signal);
            }
            for (const { symbolKey, kind, signal } of symbolVotes) {
                if (nodeById.has(symbolKey)) addVote(symbolKey, kind, signal);
            }
        }

        const domainBuckets: Map<string, { nodeIds: string[]; signals: WorkflowSignal[]; rawScoreSum: number }> = new Map();
        for (const node of allNodes) {
            const votes = nodeKindVotes.get(node.id);
            if (!votes || votes.size === 0) {
                const kind = WorkflowKind.Uncategorized;
                let bucket = domainBuckets.get(kind);
                if (!bucket) { bucket = { nodeIds: [], signals: [], rawScoreSum: 0 }; domainBuckets.set(kind, bucket); }
                bucket.nodeIds.push(node.id);
                continue;
            }
            let best: { kind: string; score: number; signals: WorkflowSignal[] } | null = null;
            votes.forEach((entry, kind) => {
                if (!best || entry.score > best.score) best = { kind, score: entry.score, signals: entry.signals };
            });
            if (!best) continue;
            const winner = best as { kind: string; score: number; signals: WorkflowSignal[] };
            let bucket = domainBuckets.get(winner.kind);
            if (!bucket) { bucket = { nodeIds: [], signals: [], rawScoreSum: 0 }; domainBuckets.set(winner.kind, bucket); }
            bucket.nodeIds.push(node.id);
            bucket.signals.push(...winner.signals);
            bucket.rawScoreSum += winner.score;
        }

        const domains: WorkflowDomain[] = [];
        domainBuckets.forEach((bucket, kind) => {
            if (bucket.nodeIds.length === 0) return;
            const id = kind.toLowerCase().replace(/[^a-z0-9]+/g, '-');
            const seen = new Set<string>();
            const uniqSignals = bucket.signals.filter(s => {
                const k = `${s.source}:${s.value}`;
                if (seen.has(k)) return false;
                seen.add(k);
                return true;
            }).slice(0, 12);
            const avg = bucket.rawScoreSum / bucket.nodeIds.length;
            const confidence = kind === WorkflowKind.Uncategorized ? 0 : Math.min(100, Math.round(avg * 18));
            domains.push({
                id, name: kind, kind: kind as WorkflowKind,
                memberNodeIds: bucket.nodeIds,
                signals: uniqSignals, confidence
            });
        });

        domains.sort((a, b) => {
            if (a.kind === WorkflowKind.Uncategorized) return 1;
            if (b.kind === WorkflowKind.Uncategorized) return -1;
            return b.memberNodeIds.length - a.memberNodeIds.length;
        });

        return domains;
    }

    public aggregate(
        domains: WorkflowDomain[],
        diff: DiffReport,
        risks: RiskReport[]
    ): WorkflowRiskAggregate[] {
        const runtimeRiskCatalog: RuntimeRiskData = loadRuntimeRisks(this.projectRoot);
        const impactedSet = new Set(diff.impactedNodes.map(n => n.id));
        const addedSet = new Set(diff.addedNodes.map(n => n.id));
        const removedSet = new Set(diff.removedNodes.map(n => n.id));
        const riskByNode = new Map(risks.map(r => [r.nodeId, r]));

        return domains.map(d => {
            const members = new Set(d.memberNodeIds);
            const impacted = d.memberNodeIds.filter(id => impactedSet.has(id));
            const added = d.memberNodeIds.filter(id => addedSet.has(id));
            const removed = d.memberNodeIds.filter(id => removedSet.has(id));

            const memberRisks: RiskReport[] = [];
            for (const id of d.memberNodeIds) {
                const r = riskByNode.get(id);
                if (r) memberRisks.push(r);
            }
            const topRisks = [...memberRisks].sort((a, b) => b.score.overallRisk - a.score.overallRisk).slice(0, 5);
            const avgRisk = memberRisks.length > 0
                ? memberRisks.reduce((s, r) => s + r.score.overallRisk, 0) / memberRisks.length : 0;
            const maxRisk = memberRisks.reduce((m, r) => Math.max(m, r.score.overallRisk), 0);
            const blastSum = memberRisks.reduce((s, r) => s + r.score.blastRadius, 0);

            const narrative = buildNarrative(d, members, impacted, added, removed, avgRisk);
            const runtimeRisks = (runtimeRiskCatalog[d.kind] || []).slice();
            const extraTexts = this.extraRiskTexts[d.kind] || this.extraRiskTexts[d.name] || [];
            for (const t of extraTexts) if (!runtimeRisks.includes(t)) runtimeRisks.push(t);
            if (impacted.length > 0 && runtimeRisks.length === 0) {
                runtimeRisks.push('behavioral drift in dependent paths');
            }

            return {
                workflowId: d.id,
                workflowName: d.name,
                kind: d.kind,
                memberCount: d.memberNodeIds.length,
                impactedCount: impacted.length,
                addedCount: added.length,
                removedCount: removed.length,
                averageRisk: parseFloat(avgRisk.toFixed(2)),
                maxRisk: parseFloat(maxRisk.toFixed(2)),
                blastRadiusSum: blastSum,
                topRisks, narrative, runtimeRisks
            };
        }).sort((a, b) => b.maxRisk - a.maxRisk || b.impactedCount - a.impactedCount);
    }

    public report(
        report: RepositoryIntelligenceReport,
        graph: BehavioralGraph,
        diff: DiffReport,
        risks: RiskReport[]
    ): WorkflowReport {
        const domains = this.classify(report, graph);
        const aggregates = this.aggregate(domains, diff, risks);
        const uncategorized = domains.find(d => d.kind === WorkflowKind.Uncategorized);
        const nodeById = new Map(graph.getNodes().map(n => [n.id, n]));
        const unassigned: GraphNode[] = uncategorized
            ? uncategorized.memberNodeIds.map(id => nodeById.get(id)).filter((n): n is GraphNode => !!n)
            : [];
        return { workflows: domains, aggregates, unassigned };
    }
}

function buildNarrative(
    d: WorkflowDomain,
    members: Set<string>,
    impacted: string[],
    added: string[],
    removed: string[],
    avgRisk: number
): string {
    const parts: string[] = [];
    if (impacted.length === 0 && added.length === 0 && removed.length === 0) {
        parts.push(`${d.name} workflow unchanged in this diff.`);
    } else {
        const fragments: string[] = [];
        if (impacted.length > 0) fragments.push(`${impacted.length} impacted node${impacted.length > 1 ? 's' : ''}`);
        if (added.length > 0) fragments.push(`${added.length} added`);
        if (removed.length > 0) fragments.push(`${removed.length} removed`);
        parts.push(`${d.name} workflow affected: ${fragments.join(', ')}.`);
    }
    if (avgRisk >= 50) parts.push(`Average risk ${avgRisk.toFixed(0)}/100 — elevated.`);
    else if (avgRisk >= 30) parts.push(`Average risk ${avgRisk.toFixed(0)}/100 — moderate.`);
    parts.push(`Membership: ${members.size} node${members.size === 1 ? '' : 's'}.`);
    return parts.join(' ');
}
