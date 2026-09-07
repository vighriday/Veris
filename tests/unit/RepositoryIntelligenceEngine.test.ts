import { describe, it, expect, afterAll } from 'vitest';
import { RepositoryIntelligenceEngine } from '../../src/engine/RepositoryIntelligenceEngine';
import { BehavioralGraphEngine } from '../../src/engine/BehavioralGraphEngine';
import { EdgeType } from '../../src/models/GraphModels';
import { tmpDir, writeFile, cleanupAll } from './tmpRepo';

afterAll(cleanupAll);

function analyze(files: Record<string, string>, opts?: { includeOnly?: Set<string> }) {
    const root = tmpDir('veris-intel-');
    for (const [rel, content] of Object.entries(files)) writeFile(root, rel, content);
    const report = new RepositoryIntelligenceEngine(root, undefined, opts).analyze();
    return { root, report, graph: new BehavioralGraphEngine().buildGraphFromReport(report) };
}

describe('RepositoryIntelligenceEngine — identity', () => {
    // Finding B7: node ids embedded absolute filesystem paths, so a directory rename
    // churned every fingerprint and two machines could never compare results.
    it('emits repository-relative POSIX paths, never absolute ones', () => {
        const { report } = analyze({ 'src/auth/login.ts': 'export function signIn() {}' });
        expect(report.files[0].filePath).toBe('src/auth/login.ts');
        expect(report.files[0].absPath).toContain('login.ts');
        expect(report.files[0].filePath).not.toMatch(/^[A-Za-z]:|^\//);
    });

    it('produces identical ids for identical sources under different roots', () => {
        const files = { 'src/a.ts': 'export function go() {}' };
        const first = analyze(files);
        const second = analyze(files);
        expect(first.root).not.toBe(second.root);
        expect(first.graph.getNodes().map(n => n.id)).toEqual(second.graph.getNodes().map(n => n.id));
    });
});

describe('RepositoryIntelligenceEngine — what gets extracted', () => {
    // Finding B3: only getMethods() was read, so a class whose logic lives in its
    // constructor contributed no nodes and no calls at all.
    it('extracts constructors, getters and setters, not only methods', () => {
        const { report } = analyze({
            'src/svc.ts': `
                export class Service {
                    constructor() { this.setup(); }
                    setup() {}
                    get status() { return 'ok'; }
                    set status(v: string) {}
                }
            `
        });
        const kinds = report.files[0].classes[0].methods.map(m => `${m.name}:${m.kind}`);
        expect(kinds).toContain('constructor:constructor');
        expect(kinds).toContain('setup:method');
        expect(kinds).toContain('status:getter');
        expect(kinds).toContain('status:setter');
    });

    // Finding B4: the "top-level only" restriction was described in a comment and
    // never implemented, so every callback and closure became a graph node.
    it('does not promote nested closures to top-level functions', () => {
        const { report } = analyze({
            'src/a.ts': `
                export function outer() {
                    const innerHelper = () => 1;
                    return innerHelper();
                }
            `
        });
        const names = report.files[0].functions.map(f => f.name);
        expect(names).toContain('outer');
        expect(names).not.toContain('innerHelper');
    });

    // Finding B5: one flat per-file name set meant a nested declaration seen first
    // suppressed the genuine exported one later in the same file.
    it('keeps the real top-level declaration when a nested one shares its name', () => {
        const { report } = analyze({
            'src/a.ts': `
                function wrapper() { const handler = () => 1; return handler; }
                export function handler() { return 2; }
            `
        });
        expect(report.files[0].functions.map(f => f.name)).toContain('handler');
    });

    // Finding A6: ignores were anchored to the project root, so nested dependency
    // trees were parsed as first-party code — 1,667 of 1,735 files on the real repo.
    it('excludes nested node_modules, not only a top-level one', () => {
        const { report } = analyze({
            'src/a.ts': 'export function mine() {}',
            'node_modules/dep/index.js': 'function topLevelDep() {}',
            'examples/runs/node_modules/dep/index.js': 'function nestedDep() {}',
            'packages/app/node_modules/other/index.js': 'function deepDep() {}',
        });
        expect(report.files.map(f => f.filePath)).toEqual(['src/a.ts']);
    });

    it('honours an explicit include list', () => {
        const { report } = analyze(
            { 'src/a.ts': 'export function a() {}', 'src/b.ts': 'export function b() {}' },
            { includeOnly: new Set(['src/a.ts']) }
        );
        expect(report.files.map(f => f.filePath)).toEqual(['src/a.ts']);
        expect(report.stats.filesSkipped).toBeGreaterThan(0);
    });
});

describe('RepositoryIntelligenceEngine — call resolution', () => {
    // Finding B1: the callee was `getText().split('.').pop()` matched against a global
    // name index, so an edge was drawn to EVERY declaration sharing that trailing
    // name. 91% of emitted edges pointed at an ambiguous name.
    it('resolves an imported call to exactly one target', () => {
        const { graph } = analyze({
            'src/b.ts': 'export function doWork() { return 1; }',
            'src/a.ts': `
                import { doWork } from './b';
                export function go() { return doWork(); }
            `,
        });
        const invokes = graph.getEdges().filter(e => e.type === EdgeType.Invokes && e.sourceId === 'src/a.ts::go');
        expect(invokes).toHaveLength(1);
        expect(invokes[0].targetId).toBe('src/b.ts::doWork');
        expect(invokes[0].resolution).toBe('resolved');
    });

    it('does not invent an edge for a same-named declaration that was never imported', () => {
        const { graph } = analyze({
            'src/logger.ts': 'export class Logger { log(msg: string) {} }',
            'src/a.ts': 'export function go() { console.log("hi"); }',
        });
        const bogus = graph.getEdges().filter(e =>
            e.sourceId === 'src/a.ts::go' && e.targetId.includes('Logger'));
        expect(bogus).toHaveLength(0);
    });

    it('emits no edge when a bare name matches several declarations', () => {
        const { report, graph } = analyze({
            'src/one.ts': 'export function handle() {}',
            'src/two.ts': 'export function handle() {}',
            // Untyped dynamic dispatch the checker cannot resolve.
            'src/caller.js': 'function go(obj) { return obj.handle(); }',
        });
        const fromCaller = graph.getEdges().filter(e =>
            e.sourceId === 'src/caller.js::go' && e.type === EdgeType.Invokes);
        expect(fromCaller).toHaveLength(0);
        expect(report.stats.callsResolved + report.stats.callsHeuristic + report.stats.callsAmbiguous)
            .toBeGreaterThan(0);
    });

    it('records resolution statistics so ambiguity is visible, not hidden', () => {
        const { report } = analyze({
            'src/b.ts': 'export function doWork() {}',
            'src/a.ts': `import { doWork } from './b'; export function go() { return doWork(); }`,
        });
        expect(report.stats.callsResolved).toBeGreaterThan(0);
        expect(report.stats.filesAnalyzed).toBe(2);
    });
});

describe('RepositoryIntelligenceEngine — body hashing', () => {
    // Finding B8: a fingerprint over names and topology cannot see a rewritten body.
    it('changes the hash when the body changes', () => {
        const before = analyze({ 'src/a.ts': 'export function charge(n: number) { return pay(n); }' });
        const after = analyze({ 'src/a.ts': 'export function charge(n: number) { return pay(n * 100); }' });
        expect(before.report.files[0].functions[0].bodyHash)
            .not.toBe(after.report.files[0].functions[0].bodyHash);
    });

    it('ignores comments and reformatting', () => {
        const plain = analyze({ 'src/a.ts': 'export function charge(n: number) { return n; }' });
        const commented = analyze({
            'src/a.ts': `export function charge(n: number) {
                // a comment that changes nothing
                return    n;
            }`
        });
        expect(plain.report.files[0].functions[0].bodyHash)
            .toBe(commented.report.files[0].functions[0].bodyHash);
    });
});

describe('BehavioralGraphEngine — import edges', () => {
    // Finding B2: file basenames were stripped of their extension but import
    // specifiers were not, so `from './target.js'` never matched and every ESM /
    // NodeNext repository produced zero import edges.
    it('matches an extensioned ESM specifier', () => {
        const { graph } = analyze({
            'src/target.ts': 'export class Target {}',
            'src/a.ts': `import { Target } from './target.js'; export class A { use() {} }`,
        });
        const edge = graph.getEdges().find(e =>
            e.sourceId === 'src/a.ts::A' && e.targetId === 'src/target.ts::Target' && e.type === EdgeType.DependsOn);
        expect(edge).toBeDefined();
    });

    it('creates no import edge for a bare package specifier', () => {
        const { graph } = analyze({
            'src/a.ts': `import * as fs from 'fs'; export class A {}`,
        });
        const cross = graph.getEdges().filter(e => e.type === EdgeType.DependsOn && !e.targetId.startsWith('src/a.ts::A'));
        expect(cross).toHaveLength(0);
    });

    it('labels every edge with how it was established', () => {
        const { graph } = analyze({
            'src/b.ts': 'export function doWork() {}',
            'src/a.ts': `import { doWork } from './b'; export function go() { return doWork(); }`,
        });
        expect(graph.getEdges().every(e => !!e.resolution)).toBe(true);
    });
});
