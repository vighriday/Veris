import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RepositoryIntelligenceEngine } from './RepositoryIntelligenceEngine';
import { BehavioralGraphEngine } from './BehavioralGraphEngine';
import { BehavioralGraph } from '../models/GraphModels';
import { AnalysisStats } from '../models/EntityModels';
import { RepositoryIntelligenceReport } from '../models/EntityModels';

/**
 * Produces two real behavioral graph snapshots from two git states via worktree.
 *
 * There is no synthetic fallback. When a baseline cannot be established the run
 * fails with a reason: a verification tool that fabricates the thing it is
 * verifying against is worse than one that refuses to answer.
 *
 * Security: uses execFileSync (no shell) and validates refs against a strict
 * allowlist so a user-supplied --base-ref cannot inject arguments or shell.
 */

const REF_ALLOWED = /^[A-Za-z0-9][A-Za-z0-9._\/\-~^]{0,254}$/;

function isSafeRef(ref: string): boolean {
    if (!ref) return false;
    if (ref.length > 255) return false;
    if (ref.includes('..')) return false;
    if (/[\s\\;&|`$()<>]/.test(ref)) return false;
    return REF_ALLOWED.test(ref);
}

export class BaselineError extends Error {
    constructor(public readonly reason: string, message: string) {
        super(message);
        this.name = 'BaselineError';
    }
}

export type BaseResolution =
    | { ok: true; baseRef: string; mergeBase: string; usedMergeBase: boolean }
    | { ok: false; reason: string };

export interface GitDiffSnapshots {
    baseGraph: BehavioralGraph;
    headGraph: BehavioralGraph;
    headReport: RepositoryIntelligenceReport;
    /** The ref the user asked for (or the first candidate that resolved). */
    baseRef: string;
    /** The commit actually compared against — the merge-base when one exists. */
    baseCommit: string;
    /**
     * `<sha>` when the working tree is clean, `<sha>-dirty` when it is not. The head
     * graph is always built from the working tree, so a bare SHA would claim
     * commit-to-commit provenance for a comparison that included uncommitted edits.
     */
    headRef: string;
    dirty: boolean;
    dirtyFileCount: number;
    trackedFileCount: number;
    baseStats: AnalysisStats;
    headStats: AnalysisStats;
}

export class GitDiffDriver {
    constructor(private projectRoot: string) {}

    private git(args: string[], cwd = this.projectRoot): string {
        return execFileSync('git', args, { cwd, stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 })
            .toString();
    }

    private gitQuiet(args: string[], cwd = this.projectRoot): string | null {
        try {
            return this.git(args, cwd);
        } catch {
            return null;
        }
    }

    public isGitRepo(): boolean {
        return this.gitQuiet(['rev-parse', '--is-inside-work-tree']) !== null;
    }

    private verifyRef(ref: string): boolean {
        if (!isSafeRef(ref)) return false;
        return this.gitQuiet(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]) !== null;
    }

    /**
     * Resolves the commit to compare against.
     *
     * Uses `git merge-base HEAD <ref>` — the point the branch diverged — rather than
     * the ref's current tip. Diffing against the tip reports every commit others
     * merged since the branch was cut as behaviour *this* branch removed.
     */
    public resolveBase(explicit?: string): BaseResolution {
        if (!this.isGitRepo()) {
            return { ok: false, reason: 'not a git repository' };
        }

        let baseRef: string | null = null;
        if (explicit) {
            if (!isSafeRef(explicit)) {
                return { ok: false, reason: `unsafe base ref ${JSON.stringify(explicit)}` };
            }
            if (!this.verifyRef(explicit)) {
                return { ok: false, reason: `base ref '${explicit}' does not resolve to a commit` };
            }
            baseRef = explicit;
        } else {
            const candidates = ['origin/main', 'origin/master', 'main', 'master', 'HEAD~1'];
            baseRef = candidates.find(ref => this.verifyRef(ref)) ?? null;
            if (!baseRef) {
                return {
                    ok: false,
                    reason: 'no base ref resolved (tried origin/main, origin/master, main, master, HEAD~1)'
                };
            }
        }

        const mergeBase = this.gitQuiet(['merge-base', 'HEAD', baseRef])?.trim();
        if (mergeBase) {
            return { ok: true, baseRef, mergeBase, usedMergeBase: true };
        }
        // Unrelated histories, or a shallow clone with no common ancestor. The ref
        // itself is still a defensible baseline, but say which was used.
        const tip = this.gitQuiet(['rev-parse', `${baseRef}^{commit}`])?.trim();
        if (!tip) return { ok: false, reason: `could not resolve '${baseRef}' to a commit` };
        return { ok: true, baseRef, mergeBase: tip, usedMergeBase: false };
    }

    /** Project-root-relative POSIX paths of every git-tracked source file. */
    public trackedFiles(ref?: string): Set<string> {
        const out = new Set<string>();
        const raw = ref
            ? this.gitQuiet(['ls-tree', '-r', '--name-only', '-z', ref, '--', '.'])
            : this.gitQuiet(['ls-files', '-z', '--', '.']);
        if (raw === null) return out;
        for (const p of raw.split('\0')) {
            if (p) out.add(p.replace(/\\/g, '/'));
        }
        return out;
    }

    private dirtyCount(): number {
        const raw = this.gitQuiet(['status', '--porcelain', '--untracked-files=no']);
        if (!raw) return 0;
        return raw.split('\n').filter(l => l.trim().length > 0).length;
    }

    private gitRoot(): string | null {
        return this.gitQuiet(['rev-parse', '--show-toplevel'])?.trim() ?? null;
    }

    /**
     * Builds both snapshots. Throws `BaselineError` rather than returning null — a
     * caller must not be able to proceed with no baseline by ignoring a return value.
     */
    public snapshot(baseRef?: string): GitDiffSnapshots {
        const resolution = this.resolveBase(baseRef);
        if (!resolution.ok) {
            throw new BaselineError(resolution.reason, `Cannot establish a baseline: ${resolution.reason}.`);
        }

        const headSha = this.gitQuiet(['rev-parse', 'HEAD'])?.trim() ?? 'unknown';
        const dirtyFileCount = this.dirtyCount();
        const dirty = dirtyFileCount > 0;

        // Head is the working tree, so identify it as such.
        const headRef = dirty ? `${headSha}-dirty` : headSha;

        const headTracked = this.trackedFiles();
        const headIntel = new RepositoryIntelligenceEngine(this.projectRoot, undefined, { includeOnly: headTracked });
        const headReport = headIntel.analyze();
        const graphEngine = new BehavioralGraphEngine();
        const headGraph = graphEngine.buildGraphFromReport(headReport);

        // Scope the base analysis to the same subpath the user pointed at, so running
        // `veris .` inside a subfolder of a larger repo does not pull the whole parent
        // tree into the diff.
        const rootAbs = this.gitRoot();
        const projAbs = path.resolve(this.projectRoot);
        const subPath = rootAbs ? path.relative(rootAbs, projAbs) : '';

        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'veris-worktree-'));
        let baseGraph: BehavioralGraph;
        let baseStats: AnalysisStats;
        let worktreeCreated = false;

        try {
            try {
                this.git(['worktree', 'add', '--detach', tmpDir, resolution.mergeBase]);
                worktreeCreated = true;
            } catch (err) {
                const msg = ((err as Error).message || '').split('\n')[0];
                const hint = /Filename too long|MAX_PATH|unable to create file/i.test(msg)
                    ? ' (likely the Windows MAX_PATH limit — try a shorter checkout path)'
                    : '';
                throw new BaselineError('worktree-failed', `git worktree failed${hint}: ${msg}`);
            }

            const baseAnalysisRoot = subPath ? path.join(tmpDir, subPath) : tmpDir;
            if (subPath && !fs.existsSync(baseAnalysisRoot)) {
                // The subfolder did not exist at the base commit, so head is entirely new.
                // An empty base graph is a true statement about that; falling back to the
                // parent tree would invent removals against unrelated nodes.
                baseGraph = new BehavioralGraph();
                baseStats = emptyStats();
            } else {
                const baseTracked = this.trackedFiles(resolution.mergeBase);
                const scopedBase = subPath ? reroot(baseTracked, subPath) : baseTracked;
                const baseIntel = new RepositoryIntelligenceEngine(baseAnalysisRoot, undefined, { includeOnly: scopedBase });
                const baseReport = baseIntel.analyze();
                // No path rewriting: `filePath` is relative to the analysis root on both
                // sides, so the same file yields the same node id in the worktree and in
                // the project. The rewrite this replaces missed `dependencyMap`, which is
                // what zeroed out every import edge in the base graph.
                baseGraph = graphEngine.buildGraphFromReport(baseReport);
                baseStats = baseReport.stats;
            }
        } finally {
            if (worktreeCreated) {
                this.gitQuiet(['worktree', 'remove', '--force', tmpDir]);
            } else {
                try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
                this.gitQuiet(['worktree', 'prune']);
            }
        }

        return {
            baseGraph,
            headGraph,
            headReport,
            baseRef: resolution.baseRef,
            baseCommit: resolution.mergeBase,
            headRef,
            dirty,
            dirtyFileCount,
            trackedFileCount: headTracked.size,
            baseStats,
            headStats: headReport.stats
        };
    }
}

/** Re-express repo-root-relative tracked paths as analysis-root-relative. */
function reroot(paths: Set<string>, subPath: string): Set<string> {
    const prefix = subPath.replace(/\\/g, '/').replace(/\/$/, '') + '/';
    const out = new Set<string>();
    for (const p of paths) {
        if (p.startsWith(prefix)) out.add(p.slice(prefix.length));
    }
    return out;
}

function emptyStats(): AnalysisStats {
    return {
        filesAnalyzed: 0, filesSkipped: 0,
        callsResolved: 0, callsHeuristic: 0, callsAmbiguous: 0, callsExternal: 0,
        truncated: false
    };
}
