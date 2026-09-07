import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CrossRepoRegistry } from '../../src/persistence/CrossRepoRegistry';
import { VerisState, RunRecord } from '../../src/persistence/VerisState';

const tmpDirs: string[] = [];

function makeTmpDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(dir);
    return dir;
}

/** A registry rooted in a directory that does not exist yet, so creation is observable. */
function registryHome(): string {
    return path.join(makeTmpDir('veris-reg-'), 'home', '.veris');
}

/** A repo directory with no .veris in it. */
function makeRepo(): string {
    return makeTmpDir('veris-repo-');
}

function run(over: Partial<RunRecord> = {}): RunRecord {
    return {
        runId: 'run-1', ts: '2026-01-01T00:00:00.000Z', diffMode: 'git', baseRef: 'main', headRef: 'HEAD',
        overallConfidence: 62, executionDepth: 0.4, nodes: 10, edges: 8, workflows: 2, impactedNodes: 3,
        ...over,
    };
}

/** Seeds a real state database in `repoPath` the way a completed Veris run would. */
function seedState(repoPath: string, rec: RunRecord = run()): void {
    const state = new VerisState(repoPath);
    state.recordRun(rec);
    state.close();
}

afterEach(() => {
    while (tmpDirs.length) {
        const d = tmpDirs.pop()!;
        fs.rmSync(d, { recursive: true, force: true });
    }
});

describe('CrossRepoRegistry construction', () => {
    it('creates nothing when the registry is only read', () => {
        const dir = registryHome();
        const reg = new CrossRepoRegistry({ dir });

        expect(fs.existsSync(dir)).toBe(false);
        expect(reg.list()).toEqual([]);
        expect(reg.loadError).toBeNull();
    });

    it('creates the registry directory on the first write', () => {
        const dir = registryHome();
        const reg = new CrossRepoRegistry({ dir });
        reg.register('payments', makeRepo());

        expect(fs.existsSync(reg.file)).toBe(true);
        expect(JSON.parse(fs.readFileSync(reg.file, 'utf8')).repos).toHaveLength(1);
    });

    it('hands out copies, so a caller cannot mutate registry state', () => {
        const dir = registryHome();
        const reg = new CrossRepoRegistry({ dir });
        reg.register('payments', makeRepo(), ['prod']);

        const entry = reg.list()[0];
        entry.name = 'hijacked';
        entry.tags!.push('injected');

        expect(reg.list()[0].name).toBe('payments');
        expect(reg.list()[0].tags).toEqual(['prod']);
    });
});

describe('CrossRepoRegistry.snapshot', () => {
    it('creates no .veris directory in a registered repo (D6)', () => {
        const dir = registryHome();
        const repo = makeRepo();
        const reg = new CrossRepoRegistry({ dir });
        reg.register('payments', repo);

        const snap = reg.snapshot();

        expect(fs.existsSync(path.join(repo, '.veris'))).toBe(false);
        expect(fs.readdirSync(repo)).toEqual([]);
        expect(snap[0].status).toBe('no-data');
        expect(snap[0].lastRun).toBeNull();
    });

    it('does not resurrect a .veris directory the user deleted', () => {
        const dir = registryHome();
        const repo = makeRepo();
        seedState(repo);
        const reg = new CrossRepoRegistry({ dir });
        reg.register('payments', repo);
        fs.rmSync(path.join(repo, '.veris'), { recursive: true, force: true });

        const snap = reg.snapshot();

        expect(fs.existsSync(path.join(repo, '.veris'))).toBe(false);
        expect(snap[0].status).toBe('no-data');
    });

    it('reads the latest run when a state database exists', () => {
        const dir = registryHome();
        const repo = makeRepo();
        seedState(repo, run({ runId: 'newer', ts: '2026-02-02T00:00:00.000Z', overallConfidence: 71 }));
        const reg = new CrossRepoRegistry({ dir });
        reg.register('payments', repo, ['prod']);

        const snap = reg.snapshot();

        expect(snap).toHaveLength(1);
        expect(snap[0].status).toBe('ok');
        expect(snap[0].name).toBe('payments');
        expect(snap[0].tags).toEqual(['prod']);
        expect(snap[0].lastRun?.runId).toBe('newer');
        expect(snap[0].lastRun?.overallConfidence).toBe(71);
    });

    it('reports a repo whose path is gone instead of crashing, and does not recreate it', () => {
        const dir = registryHome();
        const repo = makeRepo();
        const reg = new CrossRepoRegistry({ dir });
        reg.register('payments', repo);
        fs.rmSync(repo, { recursive: true, force: true });

        const snap = reg.snapshot();

        expect(snap[0].status).toBe('missing');
        expect(snap[0].lastRun).toBeNull();
        expect(snap[0].error).toContain('no longer exists');
        expect(fs.existsSync(repo)).toBe(false);
    });

    it('surfaces an unreadable state database as an error, not as missing data', () => {
        const dir = registryHome();
        const repo = makeRepo();
        // A directory where state.db should be: the path exists, but nothing can read it.
        fs.mkdirSync(path.join(repo, '.veris', 'state.db'), { recursive: true });
        const reg = new CrossRepoRegistry({ dir });
        reg.register('payments', repo);

        const snap = reg.snapshot();

        expect(snap[0].status).toBe('error');
        expect(snap[0].lastRun).toBeNull();
        expect(typeof snap[0].error).toBe('string');
    });

    it('distinguishes zero-retention mode from a repo with no data', () => {
        const dir = registryHome();
        const repo = makeRepo();
        seedState(repo);
        const reg = new CrossRepoRegistry({ dir });
        reg.register('payments', repo);

        process.env.VERIS_STATE_DISABLED = '1';
        try {
            const snap = reg.snapshot();
            expect(snap[0].status).toBe('disabled');
            expect(snap[0].error).toMatch(/VERIS_STATE_DISABLED/);
        } finally {
            delete process.env.VERIS_STATE_DISABLED;
        }
    });

    it('reports every registered repo, healthy or not', () => {
        const dir = registryHome();
        const healthy = makeRepo();
        const empty = makeRepo();
        const gone = makeRepo();
        seedState(healthy);
        const reg = new CrossRepoRegistry({ dir });
        reg.register('healthy', healthy);
        reg.register('empty', empty);
        reg.register('gone', gone);
        fs.rmSync(gone, { recursive: true, force: true });

        expect(reg.snapshot().map(s => [s.name, s.status])).toEqual([
            ['healthy', 'ok'],
            ['empty', 'no-data'],
            ['gone', 'missing'],
        ]);
    });
});

describe('CrossRepoRegistry.register path validation', () => {
    it('rejects a path that does not exist', () => {
        const reg = new CrossRepoRegistry({ dir: registryHome() });
        expect(() => reg.register('ghost', path.join(makeRepo(), 'nope'))).toThrow(/does not exist/);
        expect(reg.list()).toEqual([]);
    });

    it('rejects a path that is a file', () => {
        const repo = makeRepo();
        const filePath = path.join(repo, 'README.md');
        fs.writeFileSync(filePath, '# hi', 'utf8');
        const reg = new CrossRepoRegistry({ dir: registryHome() });
        expect(() => reg.register('file', filePath)).toThrow(/not a directory/);
    });

    it('rejects an empty path and an empty name', () => {
        const reg = new CrossRepoRegistry({ dir: registryHome() });
        expect(() => reg.register('ok', '   ')).toThrow(/path is required/);
        expect(() => reg.register('  ', makeRepo())).toThrow(/name is required/);
    });

    it('rejects an over-long name and a name carrying control characters', () => {
        const reg = new CrossRepoRegistry({ dir: registryHome() });
        const repo = makeRepo();
        expect(() => reg.register('n'.repeat(101), repo)).toThrow(/100 characters/);
        expect(() => reg.register('pay\u001b[31mments', repo)).toThrow(/control characters/);
    });

    it('stores a canonical path, collapsing traversal segments', () => {
        const parent = makeTmpDir('veris-parent-');
        const repo = path.join(parent, 'service');
        fs.mkdirSync(repo);
        const reg = new CrossRepoRegistry({ dir: registryHome() });

        const entry = reg.register('service', path.join(repo, 'sub', '..', '..', 'service'));

        expect(entry.path).toBe(path.resolve(repo));
        expect(entry.path).not.toContain('..');
    });

    it('treats a differently spelled path as the same repo instead of duplicating it', () => {
        const repo = makeRepo();
        const reg = new CrossRepoRegistry({ dir: registryHome() });
        reg.register('payments', repo, ['prod']);
        reg.register('payments-api', path.join(repo, '.'));

        expect(reg.list()).toHaveLength(1);
        expect(reg.list()[0].name).toBe('payments-api');
        expect(reg.list()[0].path).toBe(path.resolve(repo));
        expect(reg.list()[0].tags).toEqual(['prod']);
    });

    it.runIf(process.platform === 'win32')('treats a case-differing path as the same repo on Windows', () => {
        const repo = makeRepo();
        const reg = new CrossRepoRegistry({ dir: registryHome() });
        reg.register('payments', repo);
        reg.register('payments', repo.toUpperCase());

        expect(reg.list()).toHaveLength(1);
    });
});

describe('CrossRepoRegistry.unregister', () => {
    it('removes by name and by path, and reports when nothing matched', () => {
        const dir = registryHome();
        const byName = makeRepo();
        const byPath = makeRepo();
        const reg = new CrossRepoRegistry({ dir });
        reg.register('by-name', byName);
        reg.register('by-path', byPath);

        expect(reg.unregister('by-name')).toBe(true);
        expect(reg.unregister(path.join(byPath, '.'))).toBe(true);
        expect(reg.unregister('never-registered')).toBe(false);
        expect(reg.list()).toEqual([]);
        expect(JSON.parse(fs.readFileSync(reg.file, 'utf8')).repos).toEqual([]);
    });

    it('ignores an empty argument rather than clearing the fleet', () => {
        const reg = new CrossRepoRegistry({ dir: registryHome() });
        reg.register('payments', makeRepo());
        expect(reg.unregister('  ')).toBe(false);
        expect(reg.list()).toHaveLength(1);
    });
});

describe('CrossRepoRegistry malformed registry file', () => {
    function writeRegistry(contents: string): string {
        const dir = registryHome();
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'registry.json'), contents, 'utf8');
        return dir;
    }

    it('reports invalid JSON instead of throwing or pretending the fleet is empty', () => {
        const reg = new CrossRepoRegistry({ dir: writeRegistry('{ this is not json') });

        expect(reg.list()).toEqual([]);
        expect(reg.snapshot()).toEqual([]);
        expect(reg.loadError).toMatch(/not valid JSON/);
    });

    it('reports valid JSON of the wrong shape', () => {
        const reg = new CrossRepoRegistry({ dir: writeRegistry('{"repos": "payments"}') });

        expect(reg.list()).toEqual([]);
        expect(reg.loadError).toMatch(/does not contain a "repos" array/);
    });

    it('keeps usable entries and reports the ones it dropped', () => {
        const repo = makeRepo();
        const dir = writeRegistry(JSON.stringify({
            repos: [
                { name: 'no-path' },
                null,
                { name: 'good', path: repo, addedAt: '2026-01-01T00:00:00.000Z', tags: ['prod', 7] },
                { name: 'blank-path', path: '   ' },
            ],
        }));
        const reg = new CrossRepoRegistry({ dir });

        expect(reg.list().map(r => r.name)).toEqual(['good']);
        expect(reg.list()[0].tags).toEqual(['prod']);
        expect(reg.loadError).toMatch(/ignored 3 entries/);
    });

    it('keeps an entry that lost its addedAt rather than dropping the repo', () => {
        const repo = makeRepo();
        const reg = new CrossRepoRegistry({ dir: writeRegistry(JSON.stringify({ repos: [{ name: 'good', path: repo }] })) });

        expect(reg.list()).toHaveLength(1);
        expect(reg.list()[0].addedAt).toBe('');
    });

    it('preserves the unparseable file before the first write replaces it', () => {
        const original = '{ hand-edited and broken';
        const dir = writeRegistry(original);
        const reg = new CrossRepoRegistry({ dir });

        reg.register('payments', makeRepo());

        const backups = fs.readdirSync(dir).filter(f => f.includes('.corrupt-'));
        expect(backups).toHaveLength(1);
        expect(fs.readFileSync(path.join(dir, backups[0]), 'utf8')).toBe(original);
        expect(JSON.parse(fs.readFileSync(reg.file, 'utf8')).repos).toHaveLength(1);
    });

    it('backs the broken file up once, not on every subsequent write', () => {
        const dir = writeRegistry('{ broken');
        const reg = new CrossRepoRegistry({ dir });

        reg.register('a', makeRepo());
        reg.register('b', makeRepo());

        expect(fs.readdirSync(dir).filter(f => f.includes('.corrupt-'))).toHaveLength(1);
    });
});
