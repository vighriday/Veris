import { describe, it, expect, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { VerisState } from '../../src/persistence/VerisState';
import { tmpDir, cleanupAll } from './tmpRepo';

afterAll(cleanupAll);

function newState(): { root: string; state: VerisState } {
    const root = tmpDir('veris-state-');
    return { root, state: new VerisState(root) };
}

function execution(over: Partial<Parameters<VerisState['recordExecution']>[0]> = {}) {
    return {
        runId: 'run1',
        nodeId: 'src/a.ts::go',
        workflowId: null,
        tier: 'Tier 1 - Structural Verification',
        directive: 'check',
        result: 'pass' as const,
        ...over,
    };
}

describe('VerisState — evidence is append-only', () => {
    // Finding D2: executions were keyed (run_id, node_id, tier) and written with
    // INSERT OR REPLACE, with one run id per process. An agent could post `fail`,
    // then post `pass` for the same target, and the failure was gone. That is a
    // working tamper primitive, not merely an unvalidated input.
    it('retains an earlier failure when a later pass is posted for the same target', () => {
        const { state } = newState();
        state.recordExecution(execution({ result: 'fail', executedAt: '2026-01-01T00:00:00.000Z' }));
        state.recordExecution(execution({ result: 'pass', executedAt: '2026-01-02T00:00:00.000Z' }));

        const rows = state.executionsForNode('src/a.ts::go');
        expect(rows).toHaveLength(2);
        expect(rows.map(r => r.result).sort()).toEqual(['fail', 'pass']);
        state.close();
    });

    it('defaults unlabelled evidence to the least trusted class', () => {
        const { state } = newState();
        state.recordExecution(execution());
        expect(state.executionsForNode('src/a.ts::go')[0].trustClass).toBe('agent-asserted');
        state.close();
    });

    it('records who produced each row', () => {
        const { state } = newState();
        state.recordExecution(execution({ producer: 'github-actions:test', trustClass: 'harness-observed' }));
        const row = state.executionsForNode('src/a.ts::go')[0];
        expect(row.producer).toBe('github-actions:test');
        expect(row.trustClass).toBe('harness-observed');
        state.close();
    });

    it('writes a batch atomically', () => {
        const { state } = newState();
        const n = state.recordExecutions([
            execution({ nodeId: 'src/a.ts::one' }),
            execution({ nodeId: 'src/a.ts::two' }),
        ]);
        expect(n).toBe(2);
        expect(state.executionsForNode('src/a.ts::one')).toHaveLength(1);
        expect(state.executionsForNode('src/a.ts::two')).toHaveLength(1);
        state.close();
    });
});

describe('VerisState — the chain detects tampering', () => {
    it('verifies an untouched chain', () => {
        const { state } = newState();
        for (let i = 0; i < 5; i++) state.recordExecution(execution({ nodeId: `src/a.ts::n${i}` }));
        const result = state.verifyEvidenceChain();
        expect(result.ok).toBe(true);
        expect(result.rowsChecked).toBe(5);
        state.close();
    });

    // The point of hash-chaining: editing history outside Veris must be detectable.
    it('detects a row edited directly in the database', () => {
        const { root, state } = newState();
        for (let i = 0; i < 3; i++) state.recordExecution(execution({ nodeId: `src/a.ts::n${i}` }));
        state.close();

        const dbPath = path.join(root, '.veris', 'state.db');
        const raw = new Database(dbPath);
        // Flip a recorded pass into a failure — the edit an attacker would actually
        // make. It must differ from the stored value, or the UPDATE is a no-op and
        // the test proves nothing.
        raw.prepare(`UPDATE evidence SET result = 'fail' WHERE seq = 2`).run();
        expect((raw.prepare(`SELECT result FROM evidence WHERE seq = 2`).get() as any).result).toBe('fail');
        raw.close();

        const reopened = new VerisState(root);
        const result = reopened.verifyEvidenceChain();
        expect(result.ok).toBe(false);
        expect(result.brokenAtSeq).toBe(2);
        reopened.close();
    });

    it('detects a deleted row', () => {
        const { root, state } = newState();
        for (let i = 0; i < 3; i++) state.recordExecution(execution({ nodeId: `src/a.ts::n${i}` }));
        state.close();

        const dbPath = path.join(root, '.veris', 'state.db');
        const raw = new Database(dbPath);
        raw.prepare(`DELETE FROM evidence WHERE seq = 2`).run();
        raw.close();

        const reopened = new VerisState(root);
        expect(reopened.verifyEvidenceChain().ok).toBe(false);
        reopened.close();
    });
});

describe('VerisState — schema migration', () => {
    // Finding E2: migrate() was `CREATE TABLE IF NOT EXISTS` plus a comment, which is
    // a no-op on an existing database. Adding a column and bumping the version would
    // have hard-crashed every existing user with no recovery but deleting history.
    it('upgrades a v1 database and carries its rows forward', () => {
        const root = tmpDir('veris-migrate-');
        const dir = path.join(root, '.veris');
        fs.mkdirSync(dir, { recursive: true });
        const dbPath = path.join(dir, 'state.db');

        // Reconstruct a v1 database exactly as the previous release wrote one.
        const legacy = new Database(dbPath);
        legacy.exec(`
            CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
            INSERT INTO schema_version (version) VALUES (1);
            CREATE TABLE executions (
                run_id TEXT NOT NULL, node_id TEXT NOT NULL, workflow_id TEXT,
                tier TEXT NOT NULL, directive TEXT NOT NULL, result TEXT NOT NULL,
                detail TEXT, duration_ms INTEGER, executed_at TEXT NOT NULL,
                PRIMARY KEY (run_id, node_id, tier)
            );
            INSERT INTO executions VALUES
                ('old-run','src/legacy.ts::fn',NULL,'Tier 1 - Structural Verification','d','pass',NULL,NULL,'2026-01-01T00:00:00.000Z');
            CREATE TABLE learned_signals (
                signal_key TEXT PRIMARY KEY, kind TEXT NOT NULL, weight REAL NOT NULL,
                votes INTEGER NOT NULL, updated_at TEXT NOT NULL
            );
        `);
        legacy.close();

        const state = new VerisState(root);
        const rows = state.executionsForNode('src/legacy.ts::fn');
        expect(rows).toHaveLength(1);
        // Provenance was never recorded in v1 and the table allowed overwrites, so the
        // row cannot be trusted above a bare assertion.
        expect(rows[0].trustClass).toBe('agent-asserted');
        expect(rows[0].producer).toBe('legacy-v1');
        expect(state.verifyEvidenceChain().ok).toBe(true);
        state.close();

        const check = new Database(dbPath, { readonly: true });
        const version = (check.prepare('SELECT version FROM schema_version').get() as any).version;
        expect(version).toBe(2);
        // Finding E3: learned_signals had zero rows and zero callers in the codebase.
        const tables = check.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as any[];
        expect(tables.map(t => t.name)).not.toContain('learned_signals');
        check.close();
    });

    it('reaches the current version on a fresh database', () => {
        const { root, state } = newState();
        state.recordExecution(execution());
        state.close();
        const check = new Database(path.join(root, '.veris', 'state.db'), { readonly: true });
        expect((check.prepare('SELECT version FROM schema_version').get() as any).version).toBe(2);
        check.close();
    });
});

describe('VerisState — read-only mode', () => {
    // Finding D6: the constructor called mkdirSync(recursive), so a read-shaped
    // cross-repo snapshot created .veris/ in every registered repository and could
    // recreate directory trees the user had deliberately deleted.
    it('creates nothing when opening a repository that has no state', () => {
        const root = tmpDir('veris-readonly-');
        const state = new VerisState(root, { readOnly: true });
        expect(fs.existsSync(path.join(root, '.veris'))).toBe(false);
        expect(state.lastRun()).toBeNull();
        state.close();
    });

    it('ignores writes on a read-only handle', () => {
        const { root, state } = newState();
        state.recordExecution(execution());
        state.close();

        const ro = new VerisState(root, { readOnly: true });
        ro.recordExecution(execution({ nodeId: 'src/a.ts::should-not-appear' }));
        expect(ro.executionsForNode('src/a.ts::should-not-appear')).toHaveLength(0);
        expect(ro.executionsForNode('src/a.ts::go')).toHaveLength(1);
        ro.close();
    });
});

describe('VerisState — disabled mode', () => {
    it('is inert and creates nothing when disabled', () => {
        const root = tmpDir('veris-disabled-');
        const state = new VerisState(root, { enabled: false });
        state.recordExecution(execution());
        expect(state.enabled).toBe(false);
        expect(state.executionsForNode('src/a.ts::go')).toHaveLength(0);
        expect(fs.existsSync(path.join(root, '.veris'))).toBe(false);
        state.close();
    });
});

describe('VerisState — node risk history', () => {
    // Finding E3: node_history held 709 rows on the real repository that nothing
    // queried, while the node_history MCP tool promised risk over time.
    it('returns the risk trajectory it records', () => {
        const { state } = newState();
        state.recordNodeRisk('run1', 'src/a.ts::go', 40, 50, '2026-01-01T00:00:00.000Z');
        state.recordNodeRisk('run2', 'src/a.ts::go', 70, 90, '2026-01-02T00:00:00.000Z');

        const history = state.nodeRiskHistory('src/a.ts::go');
        expect(history).toHaveLength(2);
        expect(history[0].risk).toBe(70);
        expect(history[1].risk).toBe(40);
        state.close();
    });
});
