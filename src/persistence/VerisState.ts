import type DatabaseType from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

/**
 * better-sqlite3 is a native module and an OPTIONAL dependency, so it is required
 * lazily rather than imported statically.
 *
 * It has no prebuilt binary for every Node/platform combination — Windows on a
 * newer Node minor is a common miss — and without one, installation falls back to a
 * source build that needs a C++ toolchain most users do not have. A static import
 * would throw at module load, taking down analysis that does not need persistence
 * at all. Veris' core value is the graph and the diff; history is an enhancement.
 *
 * When the binding is unavailable every write becomes a no-op and every read
 * returns empty, which is the same contract as VERIS_STATE_DISABLED=1.
 */
type DatabaseCtor = typeof DatabaseType;

let cachedCtor: DatabaseCtor | null | undefined;

function loadDatabaseCtor(): DatabaseCtor | null {
    if (cachedCtor !== undefined) return cachedCtor;
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const mod = require('better-sqlite3');
        cachedCtor = (mod?.default ?? mod) as DatabaseCtor;
    } catch {
        cachedCtor = null;
    }
    return cachedCtor;
}

/** True when persistence is available in this environment. */
export function isStateAvailable(): boolean {
    return loadDatabaseCtor() !== null;
}

/**
 * Veris state layer — local SQLite at .veris/state.db.
 *
 * Owns: runs, execution evidence, workflow fingerprints, node risk history.
 *
 * EVIDENCE MODEL — the important part of this file.
 *
 * Execution results arrive over MCP from whoever is doing the verifying, which is
 * usually the same agent whose work is being assessed. The previous schema keyed
 * executions on (run_id, node_id, tier) and wrote with INSERT OR REPLACE, so a
 * caller could post `fail`, then post `pass` for the same target, and the failure
 * was gone. That is a tamper primitive, not an unvalidated input.
 *
 * Evidence is therefore append-only and hash-chained: every row carries the hash of
 * the row before it, so deleting or editing history breaks the chain detectably.
 * Every row also carries:
 *
 *   producer    — who supplied it (an agent name, a CI job, `veris`)
 *   trustClass  — how much it is worth:
 *                   'veris-derived'    Veris computed it from source. Highest.
 *                   'harness-observed' An external runner observed it. High.
 *                   'agent-asserted'   The agent said so. Lowest — an agent's own
 *                                      claim can never by itself raise assurance.
 *
 * Consumers must weigh trust classes rather than treating all evidence alike.
 *
 * Privacy: VERIS_STATE_DISABLED=1 or { enabled: false } makes every write a no-op.
 * { readOnly: true } additionally creates nothing on disk — required for read-shaped
 * operations like cross-repo snapshots, which must not materialize .veris/ in
 * repositories the user only asked about.
 */

export type TrustClass = 'veris-derived' | 'harness-observed' | 'agent-asserted';

export const TRUST_CLASSES: readonly TrustClass[] = ['veris-derived', 'harness-observed', 'agent-asserted'];

export const EXECUTION_RESULTS = ['pass', 'fail', 'skipped', 'flaky'] as const;
export type ExecutionResult = typeof EXECUTION_RESULTS[number];

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
    result: ExecutionResult;
    detail?: string;
    durationMs?: number;
    executedAt?: string;
    /** Defaults to 'agent-asserted': anything posted over the wire is a claim. */
    trustClass?: TrustClass;
    /** Free-form identity of whoever supplied this. Defaults to 'unknown'. */
    producer?: string;
}

/** A persisted evidence row, including its chain position. */
export interface EvidenceRecord extends Required<Omit<ExecutionRecord, 'detail' | 'durationMs'>> {
    seq: number;
    detail: string | null;
    durationMs: number | null;
    rowHash: string;
    prevHash: string;
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

export interface NodeRiskRow {
    runId: string;
    risk: number;
    blastRadius: number;
    ts: string;
}

export interface ChainVerification {
    ok: boolean;
    rowsChecked: number;
    /** Sequence number of the first row whose hash does not match. */
    brokenAtSeq: number | null;
}

const SCHEMA_VERSION = 2;

/** v1 baseline. Applied to a fresh database, then migrations bring it forward. */
const SCHEMA_V1: string[] = [
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
    )`
];

/**
 * Ordered migrations. Each entry runs inside one transaction when the stored
 * version is below its index+2. `CREATE TABLE IF NOT EXISTS` alone is a no-op on an
 * existing database, so the previous scheme would have hard-crashed every existing
 * user the first time a column was added.
 */
const MIGRATIONS: Array<{ to: number; up: (db: DatabaseType.Database) => void }> = [
    {
        to: 2,
        up: (db) => {
            db.exec(`
                CREATE TABLE IF NOT EXISTS evidence (
                    seq INTEGER PRIMARY KEY AUTOINCREMENT,
                    run_id TEXT NOT NULL,
                    node_id TEXT NOT NULL,
                    workflow_id TEXT,
                    tier TEXT NOT NULL,
                    directive TEXT NOT NULL,
                    result TEXT NOT NULL,
                    detail TEXT,
                    duration_ms INTEGER,
                    executed_at TEXT NOT NULL,
                    producer TEXT NOT NULL,
                    trust_class TEXT NOT NULL,
                    prev_hash TEXT NOT NULL,
                    row_hash TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_evidence_node ON evidence(node_id);
                CREATE INDEX IF NOT EXISTS idx_evidence_workflow ON evidence(workflow_id);
                CREATE INDEX IF NOT EXISTS idx_evidence_run ON evidence(run_id);
                CREATE INDEX IF NOT EXISTS idx_node_history_node ON node_history(node_id);
            `);

            // Carry v1 rows forward. Their provenance was never recorded and the table
            // permitted overwrites, so they cannot be trusted above a bare assertion.
            const legacy = db.prepare(`
                SELECT run_id, node_id, workflow_id, tier, directive, result, detail,
                       duration_ms, executed_at
                FROM executions ORDER BY executed_at ASC
            `).all() as any[];

            if (legacy.length > 0) {
                let prevHash = GENESIS_HASH;
                const insert = db.prepare(`
                    INSERT INTO evidence
                    (run_id, node_id, workflow_id, tier, directive, result, detail, duration_ms,
                     executed_at, producer, trust_class, prev_hash, row_hash)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
                `);
                for (const r of legacy) {
                    const row = {
                        runId: r.run_id, nodeId: r.node_id, workflowId: r.workflow_id,
                        tier: r.tier, directive: r.directive, result: r.result,
                        detail: r.detail, durationMs: r.duration_ms, executedAt: r.executed_at,
                        producer: 'legacy-v1', trustClass: 'agent-asserted' as TrustClass
                    };
                    const rowHash = hashEvidenceRow(row, prevHash);
                    insert.run(
                        row.runId, row.nodeId, row.workflowId, row.tier, row.directive, row.result,
                        row.detail, row.durationMs, row.executedAt, row.producer, row.trustClass,
                        prevHash, rowHash
                    );
                    prevHash = rowHash;
                }
            }
            // `executions` is deliberately left in place rather than dropped: it is the
            // only copy of pre-migration history if anything here proves wrong.

            // learned_signals is dropped. It had zero rows and zero callers in the entire
            // codebase; dead schema misleads contributors about what the system does.
            db.exec(`DROP TABLE IF EXISTS learned_signals`);
        }
    }
];

const GENESIS_HASH = '0'.repeat(64);

/**
 * Field separator for the evidence row hash.
 *
 * A NUL, not a space: none of the joined values can contain one, so field
 * boundaries are unforgeable. With a space, a `directive` ending in a space and a
 * `producer` beginning with one could shift the boundary and let two materially
 * different rows hash identically — which is the one property a tamper-evident
 * chain must not have.
 *
 * Written as an escape rather than a literal control character so the source stays
 * plain ASCII; a raw NUL makes the file read as binary to grep, diffs and review
 * tools. The runtime value is unchanged, so existing chains still verify.
 */
const NUL_SEPARATOR = '\u0000';

function hashEvidenceRow(
    row: {
        runId: string; nodeId: string; workflowId: string | null; tier: string;
        directive: string; result: string; detail: string | null;
        durationMs: number | null; executedAt: string; producer: string; trustClass: string;
    },
    prevHash: string
): string {
    // Field order is part of the chain definition. Changing it invalidates every
    // existing chain, so it must only change alongside a schema migration.
    const payload = [
        prevHash, row.runId, row.nodeId, row.workflowId ?? '', row.tier, row.directive,
        row.result, row.detail ?? '', String(row.durationMs ?? ''), row.executedAt,
        row.producer, row.trustClass
    ].join(NUL_SEPARATOR);
    return crypto.createHash('sha256').update(payload).digest('hex');
}

export interface VerisStateOptions {
    enabled?: boolean;
    /**
     * Open an existing database without creating anything. A read must never
     * materialize `.veris/` in a repository the caller only asked about.
     */
    readOnly?: boolean;
}

export class VerisState {
    private db: DatabaseType.Database | null = null;
    public readonly enabled: boolean;
    public readonly dbPath: string;
    public readonly readOnly: boolean;

    constructor(projectRoot: string, opts: VerisStateOptions = {}) {
        const disabledEnv = process.env.VERIS_STATE_DISABLED === '1';
        this.enabled = !disabledEnv && (opts.enabled !== false);
        this.readOnly = opts.readOnly === true;

        const dir = path.join(projectRoot, '.veris');
        this.dbPath = path.join(dir, 'state.db');
        if (!this.enabled) return;

        if (this.readOnly) {
            if (!fs.existsSync(this.dbPath)) return;
        } else if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        try {
            const Database = loadDatabaseCtor();
            if (!Database) {
                // Optional native dependency absent. Analysis continues without
                // history rather than failing; see the note at the top of this file.
                console.error('[veris-state] better-sqlite3 unavailable — running without persistence.');
                return;
            }
            this.db = new Database(this.dbPath, this.readOnly ? { readonly: true } : {});
            if (!this.readOnly) {
                this.db.pragma('journal_mode = WAL');
                this.migrate();
            }
        } catch (e) {
            // Best-effort: a missing native binding must not take the whole run down.
            console.error('[veris-state] disabled —', (e as Error).message);
            this.db = null;
        }
    }

    private migrate(): void {
        const db = this.db;
        if (!db) return;

        for (const stmt of SCHEMA_V1) db.exec(stmt);

        const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as any;
        let current: number;
        if (!row) {
            // Fresh database: v1 tables were just created, so record v1 and let the
            // migrations below bring it to the current version by the same path an
            // existing database takes. One code path, so upgrades are exercised on
            // every fresh install rather than only at a user's first upgrade.
            db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(1);
            current = 1;
        } else {
            current = row.version as number;
        }

        if (current > SCHEMA_VERSION) {
            console.error(
                `[veris-state] state.db is at schema v${current}; this build understands v${SCHEMA_VERSION}. ` +
                `Reading may fail. Upgrade veris-core, or move .veris/state.db aside to start fresh.`
            );
            return;
        }

        for (const m of MIGRATIONS) {
            if (current >= m.to) continue;
            const apply = db.transaction(() => {
                m.up(db);
                db.prepare('UPDATE schema_version SET version = ?').run(m.to);
            });
            try {
                apply();
                current = m.to;
            } catch (e) {
                console.error(`[veris-state] migration to v${m.to} failed: ${(e as Error).message}`);
                console.error('[veris-state] continuing with the previous schema; history is intact.');
                return;
            }
        }
    }

    /**
     * True only when a database handle actually exists.
     *
     * `enabled` records what the caller asked for; `active` records what happened.
     * They differ when the optional native binding is unavailable — the caller wanted
     * persistence and did not get it — and reporting a state file that is not being
     * written is exactly the kind of confident-but-wrong output this project exists
     * to stop producing.
     */
    public get active(): boolean {
        return this.db !== null;
    }

    public close(): void {
        if (!this.db) return;
        try {
            // Fold the write-ahead log back into the database. Without this the WAL
            // grows unbounded across runs — measured at 4.1 MB against a 282 KB db.
            if (!this.readOnly) this.db.pragma('wal_checkpoint(TRUNCATE)');
        } catch {
            // checkpoint is best-effort
        }
        this.db.close();
        this.db = null;
    }

    public newRunId(): string {
        return crypto.randomBytes(8).toString('hex');
    }

    private assertWritable(): boolean {
        if (!this.db) return false;
        if (this.readOnly) {
            console.error('[veris-state] write attempted on a read-only handle; ignored');
            return false;
        }
        return true;
    }

    public recordRun(rec: RunRecord): void {
        if (!this.assertWritable()) return;
        this.db!.prepare(`
            INSERT OR REPLACE INTO runs
            (run_id, ts, diff_mode, base_ref, head_ref, overall_confidence, execution_depth, nodes, edges, workflows, impacted_nodes)
            VALUES (@runId, @ts, @diffMode, @baseRef, @headRef, @overallConfidence, @executionDepth, @nodes, @edges, @workflows, @impactedNodes)
        `).run(rec);
    }

    private lastHash(): string {
        if (!this.db) return GENESIS_HASH;
        const row = this.db.prepare('SELECT row_hash FROM evidence ORDER BY seq DESC LIMIT 1').get() as any;
        return row?.row_hash ?? GENESIS_HASH;
    }

    /**
     * Appends one evidence row. Never replaces: a later claim about the same target
     * is an additional record, and the earlier one remains readable. Contradiction is
     * something a consumer should be able to see, not something the store resolves
     * silently in favour of whoever wrote last.
     */
    public recordExecution(rec: ExecutionRecord): void {
        if (!this.assertWritable()) return;
        this.appendEvidence(rec);
    }

    /** Appends a batch atomically — either every row lands or none does. */
    public recordExecutions(recs: ExecutionRecord[]): number {
        if (!this.assertWritable()) return 0;
        const db = this.db!;
        const run = db.transaction((batch: ExecutionRecord[]) => {
            for (const r of batch) this.appendEvidence(r);
        });
        run(recs);
        return recs.length;
    }

    private appendEvidence(rec: ExecutionRecord): void {
        const db = this.db!;
        const row = {
            runId: rec.runId,
            nodeId: rec.nodeId,
            workflowId: rec.workflowId ?? null,
            tier: rec.tier,
            directive: rec.directive,
            result: rec.result,
            detail: rec.detail ?? null,
            durationMs: rec.durationMs ?? null,
            executedAt: rec.executedAt ?? new Date().toISOString(),
            producer: rec.producer ?? 'unknown',
            trustClass: rec.trustClass ?? 'agent-asserted'
        };
        const prevHash = this.lastHash();
        const rowHash = hashEvidenceRow(row, prevHash);
        db.prepare(`
            INSERT INTO evidence
            (run_id, node_id, workflow_id, tier, directive, result, detail, duration_ms,
             executed_at, producer, trust_class, prev_hash, row_hash)
            VALUES (@runId, @nodeId, @workflowId, @tier, @directive, @result, @detail, @durationMs,
                    @executedAt, @producer, @trustClass, @prevHash, @rowHash)
        `).run({ ...row, prevHash, rowHash });
    }

    /**
     * Recomputes the chain from genesis. A mismatch means rows were edited or deleted
     * outside Veris — which is exactly what an append-only log exists to reveal.
     */
    public verifyEvidenceChain(): ChainVerification {
        if (!this.db) return { ok: true, rowsChecked: 0, brokenAtSeq: null };
        const rows = this.db.prepare(`
            SELECT seq, run_id, node_id, workflow_id, tier, directive, result, detail,
                   duration_ms, executed_at, producer, trust_class, prev_hash, row_hash
            FROM evidence ORDER BY seq ASC
        `).all() as any[];

        let prevHash = GENESIS_HASH;
        for (const r of rows) {
            const expected = hashEvidenceRow({
                runId: r.run_id, nodeId: r.node_id, workflowId: r.workflow_id, tier: r.tier,
                directive: r.directive, result: r.result, detail: r.detail,
                durationMs: r.duration_ms, executedAt: r.executed_at,
                producer: r.producer, trustClass: r.trust_class
            }, prevHash);
            if (r.prev_hash !== prevHash || r.row_hash !== expected) {
                return { ok: false, rowsChecked: rows.length, brokenAtSeq: r.seq };
            }
            prevHash = r.row_hash;
        }
        return { ok: true, rowsChecked: rows.length, brokenAtSeq: null };
    }

    public recordFingerprint(rec: FingerprintRecord): void {
        if (!this.assertWritable()) return;
        this.db!.prepare(`
            INSERT OR REPLACE INTO fingerprints (workflow_id, run_id, fingerprint, member_count, ts)
            VALUES (@workflowId, @runId, @fingerprint, @memberCount, @ts)
        `).run(rec);
    }

    public recordNodeRisk(runId: string, nodeId: string, risk: number, blastRadius: number, ts: string): void {
        if (!this.assertWritable()) return;
        this.db!.prepare(`
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

    private evidenceQuery(where: string, ...params: any[]): EvidenceRecord[] {
        if (!this.db) return [];
        return this.db.prepare(`
            SELECT seq, run_id as runId, node_id as nodeId, workflow_id as workflowId, tier, directive,
                   result, detail, duration_ms as durationMs, executed_at as executedAt,
                   producer, trust_class as trustClass, prev_hash as prevHash, row_hash as rowHash
            FROM evidence WHERE ${where} ORDER BY executed_at DESC, seq DESC
        `).all(...params) as EvidenceRecord[];
    }

    public executionsForNode(nodeId: string): EvidenceRecord[] {
        return this.evidenceQuery('node_id = ?', nodeId);
    }

    public executionsForWorkflow(workflowId: string): EvidenceRecord[] {
        return this.evidenceQuery('workflow_id = ?', workflowId);
    }

    /** Risk trajectory for one node across runs. Backs the `node_history` MCP tool. */
    public nodeRiskHistory(nodeId: string, limit = 50): NodeRiskRow[] {
        if (!this.db) return [];
        return this.db.prepare(`
            SELECT run_id as runId, risk, blast_radius as blastRadius, ts
            FROM node_history WHERE node_id = ? ORDER BY ts DESC LIMIT ?
        `).all(nodeId, limit) as NodeRiskRow[];
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

    /** Every workflow id that has ever been fingerprinted. Lets drift see deletions. */
    public knownWorkflowIds(): string[] {
        if (!this.db) return [];
        const rows = this.db.prepare('SELECT DISTINCT workflow_id as id FROM fingerprints').all() as any[];
        return rows.map(r => r.id);
    }
}
