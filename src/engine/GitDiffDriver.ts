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

    public snapshot(baseRef?: string): GitDiffSnapshots | null {
        if (!this.isGitRepo()) return null;

        const resolvedBase = this.resolveBaseRef(baseRef);
        if (!resolvedBase) return null;

        const headRef = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: this.projectRoot }).toString().trim();

        const headIntel = new RepositoryIntelligenceEngine(this.projectRoot);
        const headReport = headIntel.analyze();
        const graphEngine = new BehavioralGraphEngine();
        const headGraph = graphEngine.buildGraphFromReport(headReport);

        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'veris-worktree-'));
        let baseGraph: BehavioralGraph;
        try {
            execFileSync('git', ['worktree', 'add', '--detach', tmpDir, resolvedBase], { cwd: this.projectRoot, stdio: 'pipe' });
            const baseIntel = new RepositoryIntelligenceEngine(tmpDir);
            const baseReport = baseIntel.analyze();
            baseReport.files.forEach(f => {
                f.filePath = f.filePath.replace(tmpDir.replace(/\\/g, '/'), this.projectRoot.replace(/\\/g, '/'));
            });
            baseGraph = graphEngine.buildGraphFromReport(baseReport);
        } finally {
            try {
                execFileSync('git', ['worktree', 'remove', '--force', tmpDir], { cwd: this.projectRoot, stdio: 'pipe' });
            } catch {
                // best-effort cleanup
            }
        }

        return { baseGraph, headGraph, baseRef: resolvedBase, headRef };
    }
}
