import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { VerisState, RunRecord } from './VerisState';

/**
 * Cross-repo registry — a user-level index of Veris-tracked repos.
 *
 * Lets `cross_repo_snapshot` report the latest run recorded in each repo the user has
 * linked. Useful when a workflow spans services (e.g. payments frontend + payments
 * backend + billing worker).
 *
 * Stored at ~/.veris/registry.json. Plain JSON, easy to inspect or hand-edit.
 *
 * Reading the registry is a pure read: nothing on that path creates a directory, a file,
 * or a state database — not in the user's home, and not in any registered repo.
 */
export interface RepoEntry {
    name: string;
    path: string;
    addedAt: string;
    tags?: string[];
}

/**
 * Why a registered repo did or did not contribute a run to a snapshot.
 *
 *  - `ok`       — the repo's state database was read and holds at least one run
 *  - `no-data`  — the repo exists but has no state database, or none with runs in it
 *  - `missing`  — the registered path is gone; a stale entry the user should prune
 *  - `disabled` — a state database exists but this process runs zero-retention
 *  - `error`    — the state database exists and could not be read
 */
export type RepoSnapshotStatus = 'ok' | 'no-data' | 'missing' | 'disabled' | 'error';

export interface RepoSnapshot extends RepoEntry {
    status: RepoSnapshotStatus;
    lastRun: RunRecord | null;
    /** Human-readable reason. Present for `missing`, `disabled` and `error`. */
    error?: string;
}

export interface CrossRepoRegistryOptions {
    /** Directory holding registry.json. Defaults to `~/.veris`. */
    dir?: string;
}

interface RegistryShape {
    repos: RepoEntry[];
}

const MAX_NAME_LENGTH = 100;

/**
 * VerisState keeps its database at `<root>/.veris/state.db`. The location is duplicated
 * here deliberately: the only way to ask a VerisState for its path is to construct one,
 * and its constructor calls mkdirSync — the exact write this read path must never make.
 */
const STATE_DB_RELATIVE = path.join('.veris', 'state.db');

/**
 * Classifies `<repo>/.veris/state.db` without opening it.
 *
 * VerisState swallows an open failure — it logs, sets its handle to null and keeps
 * reporting itself as enabled — so a database that exists but cannot be used would
 * otherwise be indistinguishable from a repo that has never been analyzed.
 */
function probeStateDb(dbPath: string): { kind: 'absent' | 'present' } | { kind: 'unusable'; reason: string } {
    let stat: fs.Stats;
    try {
        stat = fs.statSync(dbPath);
    } catch {
        return { kind: 'absent' };
    }
    if (!stat.isFile()) return { kind: 'unusable', reason: `${dbPath} exists but is not a file` };
    try {
        fs.accessSync(dbPath, fs.constants.R_OK);
    } catch (e) {
        return { kind: 'unusable', reason: `${dbPath} is not readable: ${(e as Error).message}` };
    }
    return { kind: 'present' };
}

/** Paths are compared case-insensitively on Windows, where the filesystem is. */
function samePath(a: string, b: string): boolean {
    const left = path.resolve(a);
    const right = path.resolve(b);
    return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function cloneEntry(entry: RepoEntry): RepoEntry {
    return { name: entry.name, path: entry.path, addedAt: entry.addedAt, tags: entry.tags ? [...entry.tags] : undefined };
}

/**
 * Accepts whatever JSON was on disk and keeps only the entries this class can act on.
 * The file is documented as hand-editable, so a half-valid file is an expected input,
 * not a crash: one bad entry must not cost the user the rest of the fleet.
 */
function coerceEntries(parsed: unknown): { repos: RepoEntry[]; rejected: number; malformed: boolean } {
    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { repos?: unknown }).repos)) {
        return { repos: [], rejected: 0, malformed: true };
    }
    const repos: RepoEntry[] = [];
    let rejected = 0;
    for (const item of (parsed as { repos: unknown[] }).repos) {
        if (!item || typeof item !== 'object') { rejected++; continue; }
        const candidate = item as Partial<RepoEntry>;
        if (typeof candidate.name !== 'string' || typeof candidate.path !== 'string' || candidate.path.trim() === '') {
            rejected++;
            continue;
        }
        repos.push({
            name: candidate.name,
            path: candidate.path,
            // An entry with no usable timestamp still points at a real repo, so it is kept
            // with an empty addedAt rather than dropped or given an invented date.
            addedAt: typeof candidate.addedAt === 'string' ? candidate.addedAt : '',
            tags: Array.isArray(candidate.tags) ? candidate.tags.filter((t): t is string => typeof t === 'string') : undefined,
        });
    }
    return { repos, rejected, malformed: false };
}

function validateName(name: string): string {
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (!trimmed) throw new Error('register: name is required');
    if (trimmed.length > MAX_NAME_LENGTH) throw new Error(`register: name must be ${MAX_NAME_LENGTH} characters or fewer`);
    // Control characters have no place in a repo label and can smuggle ANSI escapes
    // through any terminal that renders the fleet view.
    if (/[\u0000-\u001f\u007f]/.test(trimmed)) throw new Error('register: name must not contain control characters');
    return trimmed;
}

function validateRepoPath(repoPath: string): string {
    const raw = typeof repoPath === 'string' ? repoPath.trim() : '';
    if (!raw) throw new Error('register: path is required');
    // resolve() collapses traversal against the current directory, so what gets stored is
    // always a canonical absolute path — never a '../..' string re-resolved at read time,
    // when the process may sit in a different directory entirely.
    const abs = path.resolve(raw);
    let stat: fs.Stats;
    try {
        stat = fs.statSync(abs);
    } catch {
        throw new Error(`register: path does not exist: ${abs}`);
    }
    if (!stat.isDirectory()) throw new Error(`register: path is not a directory: ${abs}`);
    return abs;
}

export class CrossRepoRegistry {
    /** Absolute path to registry.json. Exposed so callers can name it in diagnostics. */
    public readonly file: string;
    /**
     * Non-null when registry.json existed but could not be used as written. Callers that
     * silently treat a broken registry as an empty one hide the user's own data from them.
     */
    public readonly loadError: string | null;

    private readonly dir: string;
    private data: RegistryShape;
    private pendingCorruptBackup: boolean;

    constructor(opts: CrossRepoRegistryOptions = {}) {
        this.dir = opts.dir ?? path.join(os.homedir(), '.veris');
        this.file = path.join(this.dir, 'registry.json');
        // No mkdir here: constructing a registry in order to read it must not create
        // ~/.veris. The directory is created lazily by persist(), on the first real write.
        const loaded = this.load();
        this.data = { repos: loaded.repos };
        this.loadError = loaded.error;
        this.pendingCorruptBackup = loaded.error !== null;
    }

    public list(): RepoEntry[] {
        return this.data.repos.map(cloneEntry);
    }

    /**
     * Adds or updates a repo. Throws on a name or path the registry cannot honour — a
     * rejected registration is better than a fleet view full of entries pointing nowhere.
     */
    public register(name: string, repoPath: string, tags?: string[]): RepoEntry {
        const cleanName = validateName(name);
        const abs = validateRepoPath(repoPath);
        const existing = this.data.repos.find(r => samePath(r.path, abs));
        if (existing) {
            existing.name = cleanName;
            // Rewrite the stored path: the same repo can arrive spelled differently
            // (relative, trailing separator, other casing on Windows), and the canonical
            // form is what every later lookup compares against.
            existing.path = abs;
            existing.tags = tags ?? existing.tags;
            this.persist();
            return cloneEntry(existing);
        }
        const entry: RepoEntry = { name: cleanName, path: abs, addedAt: new Date().toISOString(), tags };
        this.data.repos.push(entry);
        this.persist();
        return cloneEntry(entry);
    }

    /** Removes by exact name or by path (compared after resolution, not as a raw string). */
    public unregister(nameOrPath: string): boolean {
        const needle = typeof nameOrPath === 'string' ? nameOrPath.trim() : '';
        if (!needle) return false;
        const before = this.data.repos.length;
        this.data.repos = this.data.repos.filter(r => r.name !== needle && !samePath(r.path, needle));
        if (this.data.repos.length !== before) {
            this.persist();
            return true;
        }
        return false;
    }

    /**
     * Reads the latest run from each registered repo's .veris/state.db.
     *
     * Strictly read-only: a repo with no state database is reported as `no-data` and is
     * never opened, because VerisState's constructor creates `<repo>/.veris` and would
     * otherwise scatter directories across the fleet — including into repos where the
     * user deleted them on purpose.
     */
    public snapshot(): RepoSnapshot[] {
        return this.data.repos.map((repo): RepoSnapshot => {
            const entry = cloneEntry(repo);
            if (!fs.existsSync(repo.path)) {
                return { ...entry, status: 'missing', lastRun: null, error: `registered path no longer exists: ${repo.path}` };
            }
            const dbPath = path.join(repo.path, STATE_DB_RELATIVE);
            const probe = probeStateDb(dbPath);
            if (probe.kind === 'absent') {
                return { ...entry, status: 'no-data', lastRun: null };
            }
            if (probe.kind === 'unusable') {
                return { ...entry, status: 'error', lastRun: null, error: probe.reason };
            }
            let state: VerisState | null = null;
            try {
                state = new VerisState(repo.path);
                if (!state.enabled) {
                    return { ...entry, status: 'disabled', lastRun: null, error: 'local state layer disabled (VERIS_STATE_DISABLED=1)' };
                }
                const lastRun = state.lastRun();
                return { ...entry, status: lastRun ? 'ok' : 'no-data', lastRun };
            } catch (e) {
                // Surfaced rather than swallowed: an unreadable database is a different
                // fact from a repo that has never been analyzed.
                return { ...entry, status: 'error', lastRun: null, error: (e as Error).message };
            } finally {
                state?.close();
            }
        });
    }

    private load(): { repos: RepoEntry[]; error: string | null } {
        if (!fs.existsSync(this.file)) return { repos: [], error: null };
        let text: string;
        try {
            text = fs.readFileSync(this.file, 'utf8');
        } catch (e) {
            return { repos: [], error: `${this.file} could not be read: ${(e as Error).message}` };
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(text);
        } catch (e) {
            return { repos: [], error: `${this.file} is not valid JSON: ${(e as Error).message}` };
        }
        const coerced = coerceEntries(parsed);
        if (coerced.malformed) {
            return { repos: [], error: `${this.file} does not contain a "repos" array` };
        }
        if (coerced.rejected > 0) {
            return { repos: coerced.repos, error: `${this.file}: ignored ${coerced.rejected} entries without a usable name and path` };
        }
        return { repos: coerced.repos, error: null };
    }

    private persist(): void {
        if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
        // A registry we failed to parse still holds the user's data. Move it aside before
        // the first write replaces it with our (necessarily partial) in-memory view.
        if (this.pendingCorruptBackup) {
            this.pendingCorruptBackup = false;
            try {
                if (fs.existsSync(this.file)) fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
            } catch {
                // Best-effort: never block a registration because the backup could not be made.
            }
        }
        fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
    }
}
