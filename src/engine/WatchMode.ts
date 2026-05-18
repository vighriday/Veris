import * as fs from 'fs';
import * as path from 'path';

/**
 * Watch mode: re-runs a debounced callback whenever .ts/.js files change under
 * the project root. Excludes node_modules, dist, .veris, veris-reports, .git.
 *
 * Uses fs.watch (no chokidar dependency). On platforms where recursive watch
 * is unavailable (Linux pre-Node 20.6), falls back to a polling sweep.
 */
const SKIP = new Set(['node_modules', 'dist', '.veris', 'veris-reports', '.git', 'coverage', '.next', 'build']);
const EXTENSIONS = new Set(['.ts', '.js', '.mjs', '.cjs', '.tsx', '.jsx']);

export class WatchMode {
    private timer: NodeJS.Timeout | null = null;
    private watcher: fs.FSWatcher | null = null;
    private pollTimer: NodeJS.Timeout | null = null;
    private lastSweep: Map<string, number> = new Map();

    constructor(private projectRoot: string, private onChange: (changed: string[]) => void, private debounceMs = 600) {}

    public start(): void {
        try {
            this.watcher = fs.watch(this.projectRoot, { recursive: true, persistent: true }, (_event, filename) => {
                if (!filename) return;
                const rel = filename.toString();
                if (this.shouldSkip(rel)) return;
                this.kick([rel]);
            });
        } catch {
            // Linux without recursive support — fall back to polling
            this.startPolling();
        }
    }

    public stop(): void {
        if (this.watcher) { this.watcher.close(); this.watcher = null; }
        if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    }

    private shouldSkip(rel: string): boolean {
        const parts = rel.split(/[\\/]/);
        for (const p of parts) if (SKIP.has(p)) return true;
        const ext = path.extname(rel);
        if (!EXTENSIONS.has(ext)) return true;
        return false;
    }

    private kick(changed: string[]): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => this.onChange(changed), this.debounceMs);
    }

    private startPolling(): void {
        this.sweep(); // baseline
        this.pollTimer = setInterval(() => {
            const changed = this.sweep();
            if (changed.length > 0) this.kick(changed);
        }, 1500);
    }

    private sweep(rootRel = ''): string[] {
        const changed: string[] = [];
        const abs = path.join(this.projectRoot, rootRel);
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return changed; }
        for (const e of entries) {
            if (SKIP.has(e.name)) continue;
            const childRel = rootRel ? path.join(rootRel, e.name) : e.name;
            const childAbs = path.join(abs, e.name);
            if (e.isDirectory()) {
                changed.push(...this.sweep(childRel));
            } else if (EXTENSIONS.has(path.extname(e.name))) {
                try {
                    const mtime = fs.statSync(childAbs).mtimeMs;
                    const last = this.lastSweep.get(childAbs);
                    if (last === undefined || last !== mtime) {
                        changed.push(childRel);
                        this.lastSweep.set(childAbs, mtime);
                    }
                } catch { /* ignore */ }
            }
        }
        return changed;
    }
}
