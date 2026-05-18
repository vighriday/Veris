import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RepositoryIntelligenceEngine } from './RepositoryIntelligenceEngine';
import { BehavioralGraphEngine } from './BehavioralGraphEngine';
import { BehavioralGraph } from '../models/GraphModels';

export interface GitDiffSnapshots {
    baseGraph: BehavioralGraph;
    headGraph: BehavioralGraph;
    baseRef: string;
    headRef: string;
}

/**
 * Produces two real behavioral graph snapshots from two git refs via worktree.
 * Falls back to synthetic diff when not in a git repo or no base ref exists.
 *
 * Security: uses execFileSync (no shell) and validates refs against a strict
 * allowlist regex so user-supplied --base-ref cannot inject shell.
 */
const REF_ALLOWED = /^[A-Za-z0-9][A-Za-z0-9._\/\-~^]{0,254}$/;

function isSafeRef(ref: string): boolean {
    if (!ref) return false;
    if (ref.length > 255) return false;
    if (ref.includes('..')) return false;
    if (/[\s\\;&|`$()<>]/.test(ref)) return false;
    return REF_ALLOWED.test(ref);
}

export class GitDiffDriver {
    constructor(private projectRoot: string) {}

    public isGitRepo(): boolean {
        try {
            execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: this.projectRoot, stdio: 'pipe' });
            return true;
        } catch {
            return false;
        }
    }

    public resolveBaseRef(explicit?: string): string | null {
        if (explicit) {
            if (!isSafeRef(explicit)) {
                console.error(`[veris] rejected unsafe --base-ref: ${JSON.stringify(explicit)}`);
                return null;
            }
            return this.verifyRef(explicit) ? explicit : null;
        }
        const candidates = ['origin/main', 'origin/master', 'main', 'master', 'HEAD~1'];
        for (const ref of candidates) {
            if (this.verifyRef(ref)) return ref;
        }
        return null;
    }

    private verifyRef(ref: string): boolean {
        if (!isSafeRef(ref)) return false;
        try {
            execFileSync('git', ['rev-parse', '--verify', ref], { cwd: this.projectRoot, stdio: 'pipe' });
            return true;
        } catch {
            return false;
        }
    }

    private gitRoot(): string | null {
        try {
            return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: this.projectRoot })
                .toString().trim();
        } catch {
            return null;
        }
    }

    public snapshot(baseRef?: string): GitDiffSnapshots | null {
        if (!this.isGitRepo()) return null;

        const resolvedBase = this.resolveBaseRef(baseRef);
        if (!resolvedBase) return null;

        const headRef = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: this.projectRoot }).toString().trim();

        const headIntel = new RepositoryIntelligenceEngine(this.projectRoot);
        const headReport = headIntel.analyze();
        const graphEngine = new BehavioralGraphEngine();
        const headGraph = graphEngine.buildGraphFromReport(headReport);

        // Scope base analysis to the same subpath the user pointed at. Without this,
        // running `veris .` inside a subfolder of a larger repo pulls every node from
        // the parent tree into the diff and contaminates risk/probe output.
        const rootAbs = this.gitRoot();
        const projAbs = path.resolve(this.projectRoot);
        const subPath = rootAbs ? path.relative(rootAbs, projAbs) : '';

        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'veris-worktree-'));
        let baseGraph: BehavioralGraph;
        let worktreeCreated = false;
        try {
            // worktree is rooted at the git toplevel; analyze the matching subpath.
            // On Windows, large repos with deeply nested paths can exceed MAX_PATH
            // (260 chars) during checkout — git aborts and we bail to synthetic
            // diff rather than crash the run.
            try {
                execFileSync('git', ['worktree', 'add', '--detach', tmpDir, resolvedBase], {
                    cwd: this.projectRoot,
                    stdio: 'pipe'
                });
                worktreeCreated = true;
            } catch (err) {
                const msg = (err as Error).message || '';
                if (/Filename too long|MAX_PATH|unable to create file/i.test(msg)) {
                    console.error('[veris] git worktree failed (likely Windows MAX_PATH). Falling back to synthetic diff.');
                } else {
                    console.error('[veris] git worktree failed:', msg.split('\n')[0]);
                    console.error('[veris] Falling back to synthetic diff.');
                }
                return null;
            }

            const baseAnalysisRoot = subPath ? path.join(tmpDir, subPath) : tmpDir;
            const baseExists = fs.existsSync(baseAnalysisRoot);
            if (subPath && !baseExists) {
                // Subfolder didn't exist at the base ref → there is nothing to diff
                // against. Return an empty base graph so head is treated as entirely
                // new. Falling back to analyzing the parent tree contaminates risk
                // and produces a fake "-155 removed" against unrelated nodes.
                baseGraph = new BehavioralGraph();
            } else {
                const baseIntel = new RepositoryIntelligenceEngine(baseAnalysisRoot);
                const baseReport = baseIntel.analyze();
                const fromPrefix = baseAnalysisRoot.replace(/\\/g, '/');
                const toPrefix = this.projectRoot.replace(/\\/g, '/');
                baseReport.files.forEach(f => {
                    f.filePath = f.filePath.replace(fromPrefix, toPrefix);
                });
                baseGraph = graphEngine.buildGraphFromReport(baseReport);
            }
        } finally {
            if (worktreeCreated) {
                try {
                    execFileSync('git', ['worktree', 'remove', '--force', tmpDir], { cwd: this.projectRoot, stdio: 'pipe' });
                } catch {
                    // best-effort cleanup
                }
            } else {
                // git aborted mid-checkout — partial worktree may exist on disk. Prune.
                try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
                try {
                    execFileSync('git', ['worktree', 'prune'], { cwd: this.projectRoot, stdio: 'pipe' });
                } catch { /* ignore */ }
            }
        }

        return { baseGraph, headGraph, baseRef: resolvedBase, headRef };
    }
}
