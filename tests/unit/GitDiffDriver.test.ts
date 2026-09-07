import { describe, it, expect, afterAll } from 'vitest';
import * as path from 'path';
import { GitDiffDriver, BaselineError } from '../../src/engine/GitDiffDriver';
import { initRepo, commitAll, writeFile, git, tmpDir, cleanupAll } from './tmpRepo';

afterAll(cleanupAll);

describe('GitDiffDriver — refusing to invent a baseline', () => {
    // Finding A1: when git was unavailable the pipeline built a fake "before" state
    // from the first 70% of the current graph and reported the comparison as a real
    // behavioural diff, with no flag distinguishing it.
    it('throws rather than fabricating a baseline outside a git repository', () => {
        const root = tmpDir('veris-nogit-');
        writeFile(root, 'src/a.ts', 'export function a() {}');
        const driver = new GitDiffDriver(root);

        expect(driver.isGitRepo()).toBe(false);
        expect(() => driver.snapshot()).toThrow(BaselineError);
        expect(driver.resolveBase()).toEqual({ ok: false, reason: 'not a git repository' });
    });

    it('reports why a named base ref could not be used', () => {
        const root = initRepo();
        const result = new GitDiffDriver(root).resolveBase('no/such/ref');
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toMatch(/does not resolve/);
    });

    it('rejects a ref containing shell metacharacters', () => {
        const root = initRepo();
        const result = new GitDiffDriver(root).resolveBase('main; rm -rf /');
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toMatch(/unsafe/);
    });
});

describe('GitDiffDriver — merge-base', () => {
    // Finding A3: comparing against a ref's current tip meant commits others merged
    // after the branch was cut were reported as behaviour this branch removed.
    it('compares against the divergence point, not the branch tip', () => {
        const root = initRepo();
        writeFile(root, 'src/shared.ts', 'export function shared() {}');
        commitAll(root, 'shared');
        const forkPoint = git(root, ['rev-parse', 'HEAD']).trim();

        // Branch off, then let main move on independently.
        git(root, ['checkout', '-b', 'feature']);
        writeFile(root, 'src/feature.ts', 'export function feature() {}');
        commitAll(root, 'feature work');

        git(root, ['checkout', 'main']);
        writeFile(root, 'src/other.ts', 'export function landedBysomeoneElse() {}');
        commitAll(root, 'unrelated work on main');

        git(root, ['checkout', 'feature']);
        const resolution = new GitDiffDriver(root).resolveBase('main');

        expect(resolution.ok).toBe(true);
        if (resolution.ok) {
            expect(resolution.usedMergeBase).toBe(true);
            expect(resolution.mergeBase).toBe(forkPoint);
        }
    });

    it('does not report unrelated work on main as removed by this branch', () => {
        const root = initRepo();
        writeFile(root, 'src/shared.ts', 'export function shared() {}');
        commitAll(root, 'shared');

        git(root, ['checkout', '-b', 'feature']);
        writeFile(root, 'src/feature.ts', 'export function feature() {}');
        commitAll(root, 'feature work');

        git(root, ['checkout', 'main']);
        writeFile(root, 'src/other.ts', 'export function landedBysomeoneElse() {}');
        commitAll(root, 'unrelated');

        git(root, ['checkout', 'feature']);
        const snap = new GitDiffDriver(root).snapshot('main');

        const baseIds = snap.baseGraph.getNodes().map(n => n.id);
        const headIds = snap.headGraph.getNodes().map(n => n.id);
        // The other branch's function is in neither graph, so it cannot appear as a
        // removal. Against main's tip it would have been reported as removed here.
        expect(baseIds.some(id => id.includes('landedBysomeoneElse'))).toBe(false);
        expect(headIds.some(id => id.includes('landedBysomeoneElse'))).toBe(false);
        expect(headIds.some(id => id.includes('feature'))).toBe(true);
    });
});

describe('GitDiffDriver — what counts as behaviour', () => {
    // Finding A4: nothing filtered to tracked files, so build output and ignored
    // directories were reported as added behaviour. 12,438 phantom adds on this repo.
    it('excludes untracked and ignored files from the graph', () => {
        const root = initRepo();
        writeFile(root, 'src/tracked.ts', 'export function tracked() {}');
        commitAll(root, 'tracked');

        writeFile(root, 'src/untracked.ts', 'export function neverCommitted() {}');
        writeFile(root, 'ignored/generated.ts', 'export function generated() {}');

        const snap = new GitDiffDriver(root).snapshot('HEAD');
        const ids = snap.headGraph.getNodes().map(n => n.id);

        expect(ids).toContain('src/tracked.ts::tracked');
        expect(ids.some(id => id.includes('neverCommitted'))).toBe(false);
        expect(ids.some(id => id.includes('generated'))).toBe(false);
    });

    // Finding A2: the base analysis rewrote `filePath` but not the parallel
    // dependency map the graph builder read, so the base graph lost every import
    // edge on every run and the whole import structure looked newly added.
    it('produces import edges in the base graph, not only the head graph', () => {
        const root = initRepo();
        writeFile(root, 'src/target.ts', 'export class Target {}');
        writeFile(root, 'src/user.ts', `import { Target } from './target'; export class User { use() {} }`);
        commitAll(root, 'two files');

        // A change that touches neither import relationship.
        writeFile(root, 'src/unrelated.ts', 'export function unrelated() {}');
        commitAll(root, 'unrelated addition');

        const snap = new GitDiffDriver(root).snapshot('HEAD~1');
        const baseImports = snap.baseGraph.getEdges().filter(e =>
            e.sourceId === 'src/user.ts::User' && e.targetId === 'src/target.ts::Target');
        expect(baseImports.length).toBeGreaterThan(0);
    });
});

describe('GitDiffDriver — provenance', () => {
    // Finding A5: headRef was `rev-parse HEAD` while the head graph was built from the
    // working tree, so the result claimed commit-to-commit provenance for a
    // comparison that included uncommitted edits.
    it('marks the head as dirty when the working tree has uncommitted changes', () => {
        const root = initRepo();
        writeFile(root, 'src/a.ts', 'export function a() {}');
        commitAll(root, 'a');
        writeFile(root, 'src/a.ts', 'export function a() { return 1; }');

        const snap = new GitDiffDriver(root).snapshot('HEAD');
        expect(snap.dirty).toBe(true);
        expect(snap.dirtyFileCount).toBeGreaterThan(0);
        expect(snap.headRef).toMatch(/-dirty$/);
    });

    it('reports a clean tree with a bare commit sha', () => {
        const root = initRepo();
        writeFile(root, 'src/a.ts', 'export function a() {}');
        commitAll(root, 'a');

        const snap = new GitDiffDriver(root).snapshot('HEAD');
        expect(snap.dirty).toBe(false);
        expect(snap.headRef).not.toMatch(/-dirty$/);
        expect(snap.headRef).toMatch(/^[0-9a-f]{40}$/);
    });

    it('detects a rewritten body as a modified node, not merely a changed file', () => {
        const root = initRepo();
        writeFile(root, 'src/pay.ts', 'export function charge(n: number) { return n; }');
        commitAll(root, 'charge');
        // Same name, same callees, different behaviour — the silent-rewrite case.
        writeFile(root, 'src/pay.ts', 'export function charge(n: number) { return n * 100; }');
        commitAll(root, 'silently rewrite charge');

        const snap = new GitDiffDriver(root).snapshot('HEAD~1');
        const before = snap.baseGraph.getNodes().find(n => n.id === 'src/pay.ts::charge');
        const after = snap.headGraph.getNodes().find(n => n.id === 'src/pay.ts::charge');

        expect(before?.bodyHash).toBeDefined();
        expect(after?.bodyHash).toBeDefined();
        expect(before!.bodyHash).not.toBe(after!.bodyHash);
    });
});

describe('GitDiffDriver — path spelling', () => {
    // Windows CI caught this: `path.relative(gitRoot, projectRoot)` subtracts two
    // strings that can describe the same directory in non-subtractable forms. Git
    // returns a long, symlink-resolved, forward-slashed path; the analysis root may
    // be an 8.3 short name (C:\Users\RUNNER~1\...) or an unresolved macOS symlink
    // (/var vs /private/var). The difference came out as `../../..`, the base
    // analysis read the wrong directory, and the base graph was EMPTY — which reads
    // downstream as "every behavior was just added".
    //
    // Deriving the prefix from `git rev-parse --show-prefix` removes the arithmetic.
    it('analyzes the repository root when the path is spelled unusually', () => {
        const root = initRepo();
        writeFile(root, 'src/target.ts', 'export class Target {}');
        writeFile(root, 'src/user.ts', `import { Target } from './target'; export class User { use() {} }`);
        commitAll(root, 'two files');
        writeFile(root, 'src/extra.ts', 'export function extra() {}');
        commitAll(root, 'extra');

        // A trailing separator and a redundant `.` segment describe the same
        // directory but do not subtract cleanly from git's canonical form.
        const awkward = path.join(root, '.', path.sep);
        const snap = new GitDiffDriver(awkward).snapshot('HEAD~1');

        expect(snap.baseGraph.getNodes().length).toBeGreaterThan(0);
        const baseImports = snap.baseGraph.getEdges().filter(e =>
            e.sourceId === 'src/user.ts::User' && e.targetId === 'src/target.ts::Target');
        expect(baseImports.length).toBeGreaterThan(0);
    });

    it('scopes analysis to a subdirectory when pointed at one', () => {
        const root = initRepo();
        writeFile(root, 'packages/app/src/a.ts', 'export function inApp() {}');
        writeFile(root, 'other/b.ts', 'export function elsewhere() {}');
        commitAll(root, 'monorepo layout');
        writeFile(root, 'packages/app/src/c.ts', 'export function alsoInApp() {}');
        commitAll(root, 'add to app');

        const snap = new GitDiffDriver(path.join(root, 'packages', 'app')).snapshot('HEAD~1');
        const ids = snap.headGraph.getNodes().map(n => n.id);

        expect(ids.some(id => id.includes('inApp'))).toBe(true);
        // The sibling package is outside the analysis root and must not appear at all,
        // in either graph — otherwise it shows up as unrelated removed behavior.
        expect(ids.some(id => id.includes('elsewhere'))).toBe(false);
        expect(snap.baseGraph.getNodes().some(n => n.id.includes('elsewhere'))).toBe(false);
        expect(snap.baseGraph.getNodes().some(n => n.id.includes('inApp'))).toBe(true);
    });
});
