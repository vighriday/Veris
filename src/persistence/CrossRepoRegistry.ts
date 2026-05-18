import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { VerisState, RunRecord } from './VerisState';

/**
 * Cross-repo registry — a user-level index of Veris-tracked repos.
 *
 * Lets `analyze_cross_repo` query confidence + drift across multiple services
 * the user has linked. Useful when a workflow spans services (e.g. payments
 * frontend + payments backend + billing worker).
 *
 * Stored at ~/.veris/registry.json. Plain JSON, easy to inspect or hand-edit.
 */
export interface RepoEntry {
    name: string;
    path: string;
    addedAt: string;
    tags?: string[];
}

interface RegistryShape {
    repos: RepoEntry[];
}

export class CrossRepoRegistry {
    private file: string;
    private data: RegistryShape;

    constructor() {
        const dir = path.join(os.homedir(), '.veris');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        this.file = path.join(dir, 'registry.json');
        if (fs.existsSync(this.file)) {
            try {
                this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            } catch {
                this.data = { repos: [] };
            }
        } else {
            this.data = { repos: [] };
        }
    }

    public list(): RepoEntry[] {
        return [...this.data.repos];
    }

    public register(name: string, repoPath: string, tags?: string[]): RepoEntry {
        const abs = path.resolve(repoPath);
        const existing = this.data.repos.find(r => r.path === abs);
        if (existing) {
            existing.name = name;
            existing.tags = tags || existing.tags;
            this.persist();
            return existing;
        }
        const entry: RepoEntry = { name, path: abs, addedAt: new Date().toISOString(), tags };
        this.data.repos.push(entry);
        this.persist();
        return entry;
    }

    public unregister(nameOrPath: string): boolean {
        const before = this.data.repos.length;
        this.data.repos = this.data.repos.filter(r => r.name !== nameOrPath && r.path !== nameOrPath);
        if (this.data.repos.length !== before) {
            this.persist();
            return true;
        }
        return false;
    }

    /**
     * Reads the latest run from each registered repo's .veris/state.db.
     * Returns a confidence + drift snapshot across the fleet.
     */
    public snapshot(): Array<RepoEntry & { lastRun: RunRecord | null }> {
        return this.data.repos.map(repo => {
            try {
                const state = new VerisState(repo.path);
                const lastRun = state.lastRun();
                state.close();
                return { ...repo, lastRun };
            } catch {
                return { ...repo, lastRun: null };
            }
        });
    }

    private persist(): void {
        fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
    }
}
