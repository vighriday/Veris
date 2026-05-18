import { execSync } from 'child_process';
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
 * Falls back to head-only synthetic diff if repo has no base ref / not a git repo.
 */
export class GitDiffDriver {
    constructor(private projectRoot: string) {}

    public isGitRepo(): boolean {
        try {
            execSync('git rev-parse --is-inside-work-tree', { cwd: this.projectRoot, stdio: 'pipe' });
            return true;
        } catch {
            return false;
        }
    }

    public resolveBaseRef(explicit?: string): string | null {
        if (explicit) return explicit;
        const candidates = ['origin/main', 'origin/master', 'main', 'master', 'HEAD~1'];
        for (const ref of candidates) {
            try {
                execSync(`git rev-parse --verify ${ref}`, { cwd: this.projectRoot, stdio: 'pipe' });
                return ref;
            } catch {
                continue;
            }
        }
        return null;
    }

    public snapshot(baseRef?: string): GitDiffSnapshots | null {
        if (!this.isGitRepo()) return null;

        const resolvedBase = this.resolveBaseRef(baseRef);
        if (!resolvedBase) return null;

        const headRef = execSync('git rev-parse HEAD', { cwd: this.projectRoot }).toString().trim();

        // Build HEAD graph from working tree
        const headIntel = new RepositoryIntelligenceEngine(this.projectRoot);
        const headReport = headIntel.analyze();
        const graphEngine = new BehavioralGraphEngine();
        const headGraph = graphEngine.buildGraphFromReport(headReport);

        // Build BASE graph via temporary worktree
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'veris-worktree-'));
        let baseGraph: BehavioralGraph;
        try {
            execSync(`git worktree add --detach "${tmpDir}" ${resolvedBase}`, { cwd: this.projectRoot, stdio: 'pipe' });
            const baseIntel = new RepositoryIntelligenceEngine(tmpDir);
            const baseReport = baseIntel.analyze();
            // Rewrite filePaths to project-root-relative so diff matches across worktree boundary
            baseReport.files.forEach(f => {
                f.filePath = f.filePath.replace(tmpDir.replace(/\\/g, '/'), this.projectRoot.replace(/\\/g, '/'));
            });
            baseGraph = graphEngine.buildGraphFromReport(baseReport);
        } finally {
            try {
                execSync(`git worktree remove --force "${tmpDir}"`, { cwd: this.projectRoot, stdio: 'pipe' });
            } catch {
                // worktree cleanup best-effort
            }
        }

        return { baseGraph, headGraph, baseRef: resolvedBase, headRef };
    }
}
