import { RepositoryIntelligenceReport, VerisFile } from '../models/EntityModels';
import { BehavioralGraph, GraphNode } from '../models/GraphModels';
import { DiffReport } from '../models/RiskModels';
import { RiskReport } from '../models/RiskModels';
import {
    WorkflowDomain, WorkflowKind, WorkflowSignal,
    WorkflowReport, WorkflowRiskAggregate
} from '../models/WorkflowModels';
import { ExternalWorkflowRule } from '../plugins/PluginLoader';

interface Rule {
    kind: WorkflowKind;
    pathTokens?: string[];      // matched via includes against filePath (lowercased)
    importTokens?: string[];    // matched as substring against module specifiers
    symbolTokens?: string[];    // matched against class/method/function names (lowercased)
    weight?: number;            // base signal weight (default 1)
}

/**
 * Heuristic rule set. Order matters only for tie-breaks; multi-match aggregates.
 * Tokens are matched as case-insensitive substrings to be tolerant of naming.
 */
const RULES: Rule[] = [
    { kind: WorkflowKind.Authentication, pathTokens: ['auth', 'login', 'signup', 'signin', 'oauth', 'sso', 'jwt'],
      importTokens: ['passport', 'jsonwebtoken', 'bcrypt', 'argon2', '@auth/', 'next-auth', 'firebase/auth', '@clerk/', 'supabase/auth'],
      symbolTokens: ['login', 'signup', 'signin', 'authenticate', 'verifytoken', 'issuetoken', 'refreshtoken', 'oauth'] },

    { kind: WorkflowKind.Authorization, pathTokens: ['authz', 'permission', 'policy', 'rbac', 'acl', 'guard'],
      importTokens: ['casl', 'oso', 'cerbos', 'permit'], symbolTokens: ['authorize', 'haspermission', 'enforcepolicy', 'checkrole'] },

    { kind: WorkflowKind.Session, pathTokens: ['session'], importTokens: ['express-session', 'iron-session', 'cookie-session'],
      symbolTokens: ['session', 'cookie'] },

    { kind: WorkflowKind.Payments, pathTokens: ['payment', 'charge', 'stripe', 'paypal', 'braintree'],
      importTokens: ['stripe', 'paypal', 'braintree', '@stripe/', 'square', 'razorpay'],
      symbolTokens: ['processpayment', 'charge', 'refund', 'capturepayment'] },

    { kind: WorkflowKind.Billing, pathTokens: ['billing', 'invoice', 'subscription', 'plan', 'pricing'],
      symbolTokens: ['invoice', 'subscription', 'plan', 'meter', 'billing'] },

    { kind: WorkflowKind.Checkout, pathTokens: ['checkout', 'order'], symbolTokens: ['checkout', 'placeorder', 'finalizeorder'] },

    { kind: WorkflowKind.Cart, pathTokens: ['cart', 'basket'], symbolTokens: ['cart', 'basket', 'additem', 'removeitem'] },

    { kind: WorkflowKind.Notifications, pathTokens: ['notif', 'email', 'sms', 'push'],
      importTokens: ['nodemailer', 'sendgrid', 'mailgun', 'postmark', 'twilio', 'firebase-admin/messaging', 'expo-server-sdk'],
      symbolTokens: ['sendemail', 'sendnotification', 'sendsms', 'notify', 'sendpush'] },

    { kind: WorkflowKind.Webhooks, pathTokens: ['webhook', 'callback'], symbolTokens: ['webhook', 'handleevent', 'verifysignature'] },

    { kind: WorkflowKind.Realtime, pathTokens: ['socket', 'realtime', 'ws', 'pubsub'],
      importTokens: ['socket.io', 'ws', 'pusher', 'ably', 'centrifuge'], symbolTokens: ['emit', 'broadcast', 'subscribechannel'] },

    { kind: WorkflowKind.Queue, pathTokens: ['queue', 'worker', 'job'],
      importTokens: ['bullmq', 'bull', 'agenda', 'kue', 'rabbitmq', 'amqplib', 'kafkajs', 'sqs', '@aws-sdk/client-sqs'],
      symbolTokens: ['enqueue', 'dequeue', 'processjob', 'consumer', 'producer'] },

    { kind: WorkflowKind.Caching, pathTokens: ['cache'], importTokens: ['redis', 'ioredis', 'memcached', 'node-cache', 'lru-cache'],
      symbolTokens: ['cache', 'invalidate', 'evict', 'memoize'] },

    { kind: WorkflowKind.Persistence, pathTokens: ['db', 'database', 'model', 'repository', 'repo', 'dao', 'migration', 'schema'],
      importTokens: ['prisma', 'typeorm', 'sequelize', 'mongoose', 'drizzle', 'knex', 'pg', 'mysql2', 'mongodb', '@supabase/', 'firebase-admin/firestore'],
      symbolTokens: ['save', 'findby', 'findone', 'findall', 'create', 'update', 'delete', 'upsert', 'migrate'] },

    { kind: WorkflowKind.Sync, pathTokens: ['sync', 'replicate', 'replication'], symbolTokens: ['sync', 'replicate', 'reconcile'] },

    { kind: WorkflowKind.Search, pathTokens: ['search', 'index', 'elastic', 'meili'],
      importTokens: ['elasticsearch', 'meilisearch', 'algolia', 'typesense'], symbolTokens: ['indexdocument', 'searchquery', 'reindex'] },

    { kind: WorkflowKind.Onboarding, pathTokens: ['onboard', 'welcome', 'invite'], symbolTokens: ['onboard', 'invite', 'completeonboarding'] },

    { kind: WorkflowKind.Profile, pathTokens: ['profile', 'user', 'account'], symbolTokens: ['profile', 'updateprofile', 'getuser'] },

    { kind: WorkflowKind.Admin, pathTokens: ['admin', 'console', 'backoffice'], symbolTokens: ['admin', 'moderation'] },

    { kind: WorkflowKind.Analytics, pathTokens: ['analytic', 'telemetry', 'tracking', 'metric'],
      importTokens: ['mixpanel', 'segment', 'amplitude', 'posthog', '@datadog/', 'prom-client'],
      symbolTokens: ['track', 'logevent', 'instrument', 'metric'] },

    { kind: WorkflowKind.AI, pathTokens: ['ai', 'llm', 'agent', 'prompt', 'embedding', 'rag'],
      importTokens: ['openai', '@anthropic-ai/', 'langchain', 'llamaindex', 'pinecone', '@modelcontextprotocol/sdk', 'ts-morph'],
      symbolTokens: ['prompt', 'completion', 'embed', 'chat', 'tool'] },

    { kind: WorkflowKind.Routing, pathTokens: ['route', 'router', 'controller', 'handler', 'api/', 'pages/api', 'app/api'],
      importTokens: ['express', 'fastify', 'koa', 'next/server', '@nestjs/'], symbolTokens: ['get', 'post', 'put', 'delete', 'handler'] },

    { kind: WorkflowKind.Orchestration, pathTokens: ['orchestr', 'workflow', 'saga', 'pipeline'],
      importTokens: ['temporal', 'inngest', 'trigger.dev'], symbolTokens: ['orchestrate', 'pipeline', 'step', 'saga'] },

    { kind: WorkflowKind.Reporting, pathTokens: ['report', 'dashboard', 'export'],
      symbolTokens: ['generatereport', 'render', 'export', 'tomarkdown', 'tohtml'] },

    { kind: WorkflowKind.Configuration, pathTokens: ['config', 'env', 'setting'],
      symbolTokens: ['loadconfig', 'parseenv', 'configure'] },

    { kind: WorkflowKind.Infrastructure, pathTokens: ['infra', 'deploy', 'ci', 'pipeline', '.github/', 'docker', 'k8s', 'terraform'],
      symbolTokens: ['build', 'deploy', 'provision'] }
];

/**
 * Workflow narrative templates per kind. Used to produce prose impact summaries.
 */
const RUNTIME_RISKS: Partial<Record<WorkflowKind, string[]>> = {
    [WorkflowKind.Authentication]: ['stale session propagation', 'token expiry race', 'oauth refresh under retry'],
    [WorkflowKind.Authorization]: ['role-cache staleness', 'policy drift', 'permission bypass on degraded state'],
    [WorkflowKind.Session]: ['cookie/session desync', 'concurrent session race'],
    [WorkflowKind.Payments]: ['double-charge under retry', 'partial-capture failure', 'idempotency-key collision'],
    [WorkflowKind.Billing]: ['proration drift', 'subscription state mismatch', 'invoice/usage race'],
    [WorkflowKind.Checkout]: ['cart-to-order desync', 'inventory oversell', 'price drift on retry'],
    [WorkflowKind.Cart]: ['stale cart on multi-device', 'price recompute race'],
    [WorkflowKind.Notifications]: ['duplicate delivery on retry', 'fan-out amplification', 'opt-out staleness'],
    [WorkflowKind.Webhooks]: ['retry amplification on non-idempotent handlers', 'signature replay', 'ordering inversion'],
    [WorkflowKind.Realtime]: ['reconnect storm', 'message replay', 'auth-refresh mid-stream'],
    [WorkflowKind.Queue]: ['poison-message loop', 'duplicate-job processing', 'visibility-timeout drift'],
    [WorkflowKind.Caching]: ['stale-after-write', 'thundering herd on invalidation', 'cache stampede'],
    [WorkflowKind.Persistence]: ['transaction boundary leak', 'migration ordering hazard', 'N+1 on hot path'],
    [WorkflowKind.Sync]: ['split-brain on partition', 'replication lag drift', 'conflict resolution skew'],
    [WorkflowKind.Search]: ['index staleness vs source', 'reindex storm'],
    [WorkflowKind.Routing]: ['middleware ordering shift', 'auth bypass via route change'],
    [WorkflowKind.Orchestration]: ['edge-case deadlock', 'partial-step recovery hazard'],
    [WorkflowKind.AI]: ['prompt drift', 'tool-call schema break', 'context-window overflow']
};

export class WorkflowClassifier {
    private extraRules: Rule[] = [];
    private extraRiskTexts: Record<string, string[]> = {};

    public ingestPluginRules(rules: ExternalWorkflowRule[]): void {
        for (const r of rules) {
            // Map external string kind to enum if it matches; else keep raw.
            const kind = (WorkflowKind as any)[r.kind] || r.kind as any;
            this.extraRules.push({
                kind,
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
        // Index node -> votes per kind
        const nodeKindVotes: Map<string, Map<WorkflowKind, { score: number; signals: WorkflowSignal[] }>> = new Map();

        const addVote = (nodeId: string, kind: WorkflowKind, signal: WorkflowSignal) => {
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
            const fileImportsLower = (file.imports || []).map(i => i.toLowerCase());

            // Collect file-level kind votes from path + imports
            const fileSignals: { kind: WorkflowKind; signal: WorkflowSignal }[] = [];
            const allRules = RULES.concat(this.extraRules);
            for (const rule of allRules) {
                const weight = rule.weight ?? 1;
                for (const tok of rule.pathTokens || []) {
                    if (filePathLower.includes(tok)) {
                        fileSignals.push({ kind: rule.kind, signal: { source: 'path', value: tok, weight: weight * 2 } });
                    }
                }
                for (const tok of rule.importTokens || []) {
                    if (fileImportsLower.some(imp => imp.includes(tok))) {
                        fileSignals.push({ kind: rule.kind, signal: { source: 'import', value: tok, weight: weight * 3 } });
                    }
                }
            }

            // Symbol-level votes — class + method + function names
            const symbolVotes: { symbolKey: string; kind: WorkflowKind; signal: WorkflowSignal }[] = [];
            const checkSymbol = (name: string, symbolKey: string) => {
                const lower = name.toLowerCase();
                for (const rule of allRules) {
                    const weight = rule.weight ?? 1;
                    for (const tok of rule.symbolTokens || []) {
                        if (lower.includes(tok)) {
                            symbolVotes.push({ symbolKey, kind: rule.kind, signal: { source: 'symbol', value: tok, weight } });
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

            // Apply file signals to all nodes whose id begins with this file path
            const fileNodes = allNodes.filter(n => n.id.startsWith(file.filePath + '::'));
            for (const { kind, signal } of fileSignals) {
                for (const node of fileNodes) addVote(node.id, kind, signal);
            }
            // Apply symbol signals to their specific node
            for (const { symbolKey, kind, signal } of symbolVotes) {
                if (nodeById.has(symbolKey)) addVote(symbolKey, kind, signal);
            }
        }

        // Bucket nodes by their winning kind
        const domainBuckets: Map<WorkflowKind, { nodeIds: string[]; signals: WorkflowSignal[]; rawScoreSum: number }> = new Map();
        for (const node of allNodes) {
            const votes = nodeKindVotes.get(node.id);
            if (!votes || votes.size === 0) {
                // unassigned: park in Uncategorized
                let bucket = domainBuckets.get(WorkflowKind.Uncategorized);
                if (!bucket) { bucket = { nodeIds: [], signals: [], rawScoreSum: 0 }; domainBuckets.set(WorkflowKind.Uncategorized, bucket); }
                bucket.nodeIds.push(node.id);
                continue;
            }
            // Pick best-scoring kind
            let best: { kind: WorkflowKind; score: number; signals: WorkflowSignal[] } | null = null;
            votes.forEach((entry, kind) => {
                if (!best || entry.score > best.score) best = { kind, score: entry.score, signals: entry.signals };
            });
            if (!best) continue;
            const winner = best as { kind: WorkflowKind; score: number; signals: WorkflowSignal[] };
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
            // Dedupe signals by source+value
            const seen = new Set<string>();
            const uniqSignals = bucket.signals.filter(s => {
                const k = `${s.source}:${s.value}`;
                if (seen.has(k)) return false;
                seen.add(k);
                return true;
            }).slice(0, 12);
            // Confidence: scaled by average evidence per node, capped 0..100
            const avg = bucket.rawScoreSum / bucket.nodeIds.length;
            const confidence = kind === WorkflowKind.Uncategorized ? 0 : Math.min(100, Math.round(avg * 18));
            domains.push({
                id,
                name: kind,
                kind,
                memberNodeIds: bucket.nodeIds,
                signals: uniqSignals,
                confidence
            });
        });

        // Stable sort: largest workflows first, Uncategorized last
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
            const runtimeRisks = (RUNTIME_RISKS[d.kind] || []).slice();
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
                topRisks,
                narrative,
                runtimeRisks
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
