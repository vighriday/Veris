import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

/**
 * Veris state layer — local SQLite at .veris/state.db.
 *
 * Schema is migration-versioned. All writes are synchronous (better-sqlite3 is sync-only by design).
 * This file owns: runs, snapshots, executions, fingerprints, learned signals.
 *
 * Privacy: zero-retention by default means consumers can opt out via VERIS_STATE_DISABLED=1
 * or by passing { enabled: false } to the constructor — in that case all writes become no-ops.
 */

export interface RunRecord {
    runId: string;
    ts: string;
    diffMode: string;
    baseRef: string | null;
    headRef: string | null;
    overallConfidence: number;
    executionDepth: number;
    nodes: number;
    edges: number;
    workflows: number;
    impactedNodes: number;
}

export interface ExecutionRecord {
    runId: string;
    nodeId: string;
    workflowId: string | null;
    tier: string;
    directive: string;
    result: 'pass' | 'fail' | 'skipped' | 'flaky';
    detail?: string;
    durationMs?: number;
    executedAt?: string;
}

export interface FingerprintRecord {
    workflowId: string;
    runId: string;
    fingerprint: string;
    memberCount: number;
    ts: string;
}

export interface ConfidenceTrendRow {
    runId: string;
    ts: string;
    overallConfidence: number;
    executionDepth: number;
}

const SCHEMA_VERSION = 1;
const SCHEMA: string[] = [
    `CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)`,
    `CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        ts TEXT NOT NULL,
        diff_mode TEXT NOT NULL,
        base_ref TEXT,
        head_ref TEXT,
        overall_confidence REAL NOT NULL,
        execution_depth REAL NOT NULL,
        nodes INTEGER NOT NULL,
        edges INTEGER NOT NULL,
        workflows INTEGER NOT NULL,
        impacted_nodes INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS executions (
        run_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        workflow_id TEXT,
        tier TEXT NOT NULL,
        directive TEXT NOT NULL,
        result TEXT NOT NULL,
        detail TEXT,
        duration_ms INTEGER,
        executed_at TEXT NOT NULL,
        PRIMARY KEY (run_id, node_id, tier)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_exec_node ON executions(node_id)`,
    `CREATE INDEX IF NOT EXISTS idx_exec_workflow ON executions(workflow_id)`,
    `CREATE TABLE IF NOT EXISTS fingerprints (
        workflow_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        member_count INTEGER NOT NULL,
        ts TEXT NOT NULL,
        PRIMARY KEY (workflow_id, run_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_fp_workflow ON fingerprints(workflow_id)`,
    `CREATE TABLE IF NOT EXISTS node_history (
        node_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        risk REAL,
        blast_radius INTEGER,
        ts TEXT NOT NULL,
        PRIMARY KEY (node_id, run_id)
    )`,
    `CREATE TABLE IF NOT EXISTS learned_signals (
        signal_key TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        weight REAL NOT NULL,
        votes INTEGER NOT NULL,
        updated_at TEXT NOT NULL
    )`
];

export class VerisState {
    private db: Database.Database | null = null;
    public readonly enabled: boolean;
    public readonly dbPath: string;

    constructor(projectRoot: string, opts: { enabled?: boolean } = {}) {
        const disabledEnv = process.env.VERIS_STATE_DISABLED === '1';
        this.enabled = !disabledEnv && (opts.enabled !== false);
        const dir = path.join(projectRoot, '.veris');
        this.dbPath = path.join(dir, 'state.db');
        if (!this.enabled) return;
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        try {
            this.db = new Database(this.dbPath);
            this.db.pragma('journal_mode = WAL');
            this.migrate();
        } catch (e) {
            // Best-effort. If sqlite native binding missing on platform, run with no state.
            console.error('[veris-state] disabled —', (e as Error).message);
            this.db = null;
        }
    }

    private migrate(): void {
        if (!this.db) return;
        for (const stmt of SCHEMA) this.db.exec(stmt);
        const row = this.db.prepare('SELECT version FROM schema_version LIMIT 1').get() as any;
        if (!row) {
            this.db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
        }
    }

    public close(): void {
        if (this.db) this.db.close();
        this.db = null;
    }

    public newRunId(): string {
        return crypto.randomBytes(8).toString('hex');
    }

    public recordRun(rec: RunRecord): void {
        if (!this.db) return;
        this.db.prepare(`
            INSERT OR REPLACE INTO runs
            (run_id, ts, diff_mode, base_ref, head_ref, overall_confidence, execution_depth, nodes, edges, workflows, impacted_nodes)
            VALUES (@runId, @ts, @diffMode, @baseRef, @headRef, @overallConfidence, @executionDepth, @nodes, @edges, @workflows, @impactedNodes)
        `).run(rec);
    }

    public recordExecution(rec: ExecutionRecord): void {
        if (!this.db) return;
        const payload = {
            ...rec,
            detail: rec.detail ?? null,
            durationMs: rec.durationMs ?? null,
            executedAt: rec.executedAt ?? new Date().toISOString(),
            workflowId: rec.workflowId ?? null
        };
        this.db.prepare(`
            INSERT OR REPLACE INTO executions
            (run_id, node_id, workflow_id, tier, directive, result, detail, duration_ms, executed_at)
            VALUES (@runId, @nodeId, @workflowId, @tier, @directive, @result, @detail, @durationMs, @executedAt)
        `).run(payload);
    }

    public recordFingerprint(rec: FingerprintRecord): void {
        if (!this.db) return;
        this.db.prepare(`
            INSERT OR REPLACE INTO fingerprints (workflow_id, run_id, fingerprint, member_count, ts)
            VALUES (@workflowId, @runId, @fingerprint, @memberCount, @ts)
        `).run(rec);
    }

    public recordNodeRisk(runId: string, nodeId: string, risk: number, blastRadius: number, ts: string): void {
        if (!this.db) return;
        this.db.prepare(`
            INSERT OR REPLACE INTO node_history (node_id, run_id, risk, blast_radius, ts)
            VALUES (?, ?, ?, ?, ?)
        `).run(nodeId, runId, risk, blastRadius, ts);
    }

    public confidenceTrend(limit = 30): ConfidenceTrendRow[] {
        if (!this.db) return [];
        return this.db.prepare(`
            SELECT run_id as runId, ts, overall_confidence as overallConfidence, execution_depth as executionDepth
            FROM runs ORDER BY ts DESC LIMIT ?
        `).all(limit) as ConfidenceTrendRow[];
    }

    public lastRun(): RunRecord | null {
        if (!this.db) return null;
        const row = this.db.prepare(`
            SELECT run_id as runId, ts, diff_mode as diffMode, base_ref as baseRef, head_ref as headRef,
                   overall_confidence as overallConfidence, execution_depth as executionDepth,
                   nodes, edges, workflows, impacted_nodes as impactedNodes
            FROM runs ORDER BY ts DESC LIMIT 1
        `).get() as RunRecord | undefined;
        return row || null;
    }

    public executionsForNode(nodeId: string): ExecutionRecord[] {
        if (!this.db) return [];
        return this.db.prepare(`
            SELECT run_id as runId, node_id as nodeId, workflow_id as workflowId, tier, directive,
                   result, detail, duration_ms as durationMs, executed_at as executedAt
            FROM executions WHERE node_id = ? ORDER BY executed_at DESC
        `).all(nodeId) as ExecutionRecord[];
    }

    public executionsForWorkflow(workflowId: string): ExecutionRecord[] {
        if (!this.db) return [];
        return this.db.prepare(`
            SELECT run_id as runId, node_id as nodeId, workflow_id as workflowId, tier, directive,
                   result, detail, duration_ms as durationMs, executed_at as executedAt
            FROM executions WHERE workflow_id = ? ORDER BY executed_at DESC
        `).all(workflowId) as ExecutionRecord[];
    }

    public latestFingerprintFor(workflowId: string): FingerprintRecord | null {
        if (!this.db) return null;
        const row = this.db.prepare(`
            SELECT workflow_id as workflowId, run_id as runId, fingerprint, member_count as memberCount, ts
            FROM fingerprints WHERE workflow_id = ? ORDER BY ts DESC LIMIT 1
        `).get(workflowId) as FingerprintRecord | undefined;
        return row || null;
    }

    public fingerprintHistory(workflowId: string, limit = 20): FingerprintRecord[] {
        if (!this.db) return [];
        return this.db.prepare(`
            SELECT workflow_id as workflowId, run_id as runId, fingerprint, member_count as memberCount, ts
            FROM fingerprints WHERE workflow_id = ? ORDER BY ts DESC LIMIT ?
        `).all(workflowId, limit) as FingerprintRecord[];
    }

    public bumpLearnedSignal(signalKey: string, kind: string, delta: number): void {
        if (!this.db) return;
        const existing = this.db.prepare(`SELECT weight, votes FROM learned_signals WHERE signal_key = ?`).get(signalKey) as any;
        const now = new Date().toISOString();
        if (existing) {
            this.db.prepare(`UPDATE learned_signals SET weight = weight + ?, votes = votes + 1, updated_at = ? WHERE signal_key = ?`)
                .run(delta, now, signalKey);
        } else {
            this.db.prepare(`INSERT INTO learned_signals (signal_key, kind, weight, votes, updated_at) VALUES (?,?,?,1,?)`)
                .run(signalKey, kind, delta, now);
        }
    }

    public learnedSignals(): Array<{ signalKey: string; kind: string; weight: number; votes: number }> {
        if (!this.db) return [];
        return this.db.prepare(`SELECT signal_key as signalKey, kind, weight, votes FROM learned_signals ORDER BY weight DESC LIMIT 200`).all() as any[];
    }
}
