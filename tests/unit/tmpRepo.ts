import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Temporary on-disk fixtures.
 *
 * The engines that touch the filesystem and git — repository intelligence, the git
 * diff driver, state, plugins — had zero test coverage, including every control
 * SECURITY.md names as a mitigation. Testing them honestly needs real files and a
 * real git repository; mocking `execFileSync` would only assert that we call the
 * commands we already know we call, not that the result is correct.
 */

const created: string[] = [];

export function tmpDir(prefix = 'veris-test-'): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    created.push(dir);
    return dir;
}

/** Writes a file, creating parent directories. `rel` is POSIX-separated. */
export function writeFile(root: string, rel: string, content: string): string {
    const abs = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
    return abs;
}

export function cleanupAll(): void {
    while (created.length) {
        const dir = created.pop()!;
        try {
            fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
        } catch {
            // Windows can hold a handle briefly; a leaked temp dir must not fail a run.
        }
    }
}

export function git(root: string, args: string[]): string {
    return execFileSync('git', args, {
        cwd: root,
        stdio: 'pipe',
        env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'Veris Test',
            GIT_AUTHOR_EMAIL: 'test@example.invalid',
            GIT_COMMITTER_NAME: 'Veris Test',
            GIT_COMMITTER_EMAIL: 'test@example.invalid',
        },
    }).toString();
}

/** A git repository with one commit, isolated from the developer's git config. */
export function initRepo(prefix = 'veris-git-'): string {
    const root = tmpDir(prefix);
    git(root, ['init', '--initial-branch=main']);
    git(root, ['config', 'user.email', 'test@example.invalid']);
    git(root, ['config', 'user.name', 'Veris Test']);
    git(root, ['config', 'commit.gpgsign', 'false']);
    writeFile(root, '.gitignore', 'ignored/\n');
    git(root, ['add', '-A']);
    git(root, ['commit', '-m', 'initial', '--no-verify']);
    return root;
}

export function commitAll(root: string, message: string): void {
    git(root, ['add', '-A']);
    git(root, ['commit', '-m', message, '--no-verify']);
}
