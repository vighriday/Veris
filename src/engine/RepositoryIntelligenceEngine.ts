import * as crypto from 'crypto';
import * as path from 'path';
import { Project, SourceFile, SyntaxKind, Node, ClassDeclaration } from 'ts-morph';
import {
    VerisFile, VerisClass, VerisFunction, RepositoryIntelligenceReport,
    CallRef, CallResolution, AnalysisStats, MemberKind
} from '../models/EntityModels';
import { SecurityBaselineConfig } from '../models/ArchitectureModels';

/**
 * Repository Intelligence Engine.
 *
 * Ingests TypeScript or JavaScript source via ts-morph and extracts:
 *  - imports (ES `import` + CommonJS `require()`)
 *  - classes, methods, constructors, accessors, prototype assignments
 *  - top-level functions (declarations, `const fn = () => {}`, CommonJS exports)
 *  - per-symbol call targets, resolved through the TypeScript checker
 *  - a normalized body hash per declaration
 *
 * Identity: every `filePath` is project-root-relative and POSIX-separated, so node
 * ids are stable across machines, clones and the temporary worktree used for the
 * base snapshot.
 */

const DEFAULT_IGNORED = [
    'node_modules', 'dist', 'build', 'out', '.git', '.next', '.nuxt', '.svelte-kit',
    'coverage', 'vendor', 'veris-reports', 'bvi-reports', '.veris', '.turbo', '.cache'
];

/** Above this, analysis is truncated rather than producing an unusable report. */
const MAX_FILES = 20000;

export interface RepositoryIntelligenceOptions {
    /**
     * Restrict analysis to these project-root-relative POSIX paths. Supplied by the
     * git layer from `git ls-files`, so untracked and ignored files never enter the
     * graph as "added behaviour".
     */
    includeOnly?: Set<string>;
    maxFiles?: number;
}

export class RepositoryIntelligenceEngine {
    private project: Project;
    private security: SecurityBaselineConfig;
    private includeOnly?: Set<string>;
    private maxFiles: number;
    private stats: AnalysisStats = {
        filesAnalyzed: 0, filesSkipped: 0,
        callsResolved: 0, callsHeuristic: 0, callsAmbiguous: 0, callsExternal: 0,
        truncated: false
    };

    /** Declarations by name, used to disambiguate calls the checker cannot resolve. */
    private nameIndex: Map<string, string[]> = new Map();
    /** Declaration node → node id, for checker-resolved call targets. */
    private declarationIndex: Map<Node, string> = new Map();

    constructor(
        private projectRoot: string,
        security?: Partial<SecurityBaselineConfig>,
        options: RepositoryIntelligenceOptions = {}
    ) {
        this.security = {
            zeroRetentionMode: security?.zeroRetentionMode ?? true,
            airGapped: security?.airGapped ?? true,
            ignoredPaths: security?.ignoredPaths ?? DEFAULT_IGNORED
        };
        this.includeOnly = options.includeOnly;
        this.maxFiles = options.maxFiles ?? MAX_FILES;

        this.project = new Project({
            useInMemoryFileSystem: false,
            // Full type-checking stays off — it is far too slow on large repos and we
            // do not need diagnostics. Symbol resolution below only needs the program's
            // binder, which is built regardless.
            compilerOptions: { allowJs: true, checkJs: false, noEmit: true, skipLibCheck: true }
        });

        const root = projectRoot.replace(/\\/g, '/');
        const includes = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'].map(ext => `${root}/**/*.${ext}`);
        // `**/` before the segment: the previous form anchored every ignore to the
        // project root, so nested trees (examples/*/node_modules, workspace packages,
        // vendored code) were parsed as first-party source.
        const excludes = this.security.ignoredPaths.map(p => `!${root}/**/${p}/**/*`);
        this.project.addSourceFilesAtPaths([...includes, ...excludes]);
    }

    /** Project-root-relative, POSIX-separated. The basis of every node id. */
    private toRelative(absPath: string): string {
        const rel = path.relative(this.projectRoot, absPath).replace(/\\/g, '/');
        return rel === '' ? path.basename(absPath) : rel;
    }

    public analyze(): RepositoryIntelligenceReport {
        const all = this.project.getSourceFiles();

        const selected: { file: SourceFile; rel: string }[] = [];
        for (const file of all) {
            const rel = this.toRelative(file.getFilePath());
            // Defence in depth: the glob should already have excluded these, but a
            // symlinked or oddly-cased path can slip through and one nested
            // node_modules tree is enough to dominate the entire report.
            if (rel.startsWith('../') || this.isIgnored(rel)) { this.stats.filesSkipped++; continue; }
            if (this.includeOnly && !this.includeOnly.has(rel)) { this.stats.filesSkipped++; continue; }
            selected.push({ file, rel });
        }

        if (selected.length > this.maxFiles) {
            this.stats.truncated = true;
            this.stats.filesSkipped += selected.length - this.maxFiles;
            selected.length = this.maxFiles;
            console.error(`[veris] analysis truncated at ${this.maxFiles} files. Narrow the target directory for a complete graph.`);
        }

        // Two passes: index every declaration first so call resolution in pass two can
        // map a resolved declaration to a node id, including forward references.
        const shells: { file: SourceFile; rel: string; classes: VerisClass[]; functions: VerisFunction[] }[] = [];
        for (const { file, rel } of selected) {
            const classes = this.extractClasses(file, rel);
            const functions = this.extractFunctions(file, rel, classes);
            shells.push({ file, rel, classes, functions });
        }

        const report: RepositoryIntelligenceReport = {
            projectPath: this.projectRoot,
            files: [],
            dependencyMap: {},
            stats: this.stats
        };

        for (const shell of shells) {
            this.resolveCallsForFile(shell.classes, shell.functions);
            const imports = this.extractImports(shell.file);
            report.files.push({
                filePath: shell.rel,
                absPath: shell.file.getFilePath(),
                classes: shell.classes,
                functions: shell.functions,
                imports
            });
            report.dependencyMap[shell.rel] = imports;
            this.stats.filesAnalyzed++;
        }

        return report;
    }

    private isIgnored(rel: string): boolean {
        const segs = rel.split('/');
        return this.security.ignoredPaths.some(p => segs.includes(p));
    }

    // ---------------------------------------------------------------- extraction

    private extractImports(file: SourceFile): string[] {
        const out = new Set<string>();
        for (const imp of file.getImportDeclarations()) {
            const spec = imp.getModuleSpecifierValue();
            if (spec) out.add(spec);
        }
        for (const exp of file.getExportDeclarations()) {
            const spec = exp.getModuleSpecifierValue();
            if (spec) out.add(spec);
        }
        try {
            for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
                if (call.getExpression().getText() !== 'require') continue;
                const args = call.getArguments();
                if (args.length === 0) continue;
                if (args[0].getKind() === SyntaxKind.StringLiteral) {
                    out.add(args[0].getText().replace(/^['"`]|['"`]$/g, ''));
                }
            }
        } catch {
            // resilient: a malformed file must not abort the run
        }
        return Array.from(out);
    }

    private extractClasses(file: SourceFile, rel: string): VerisClass[] {
        const classes: VerisClass[] = [];

        for (const cls of file.getClasses()) {
            const className = cls.getName() || 'AnonymousClass';
            const classId = `${rel}::${className}`;
            const methods: VerisFunction[] = [];

            const addMember = (name: string, node: Node, kind: MemberKind, isExported: boolean) => {
                const memberId = `${classId}::${name}`;
                const fn: VerisFunction = {
                    name,
                    isExported,
                    kind,
                    bodyHash: this.hashBody(node),
                    calls: this.collectCallNodes(node) as any
                };
                methods.push(fn);
                this.index(name, memberId, node);
            };

            const exported = cls.isExported();
            for (const m of cls.getMethods()) addMember(m.getName(), m, 'method', exported);
            // Classes whose logic lives in the constructor — service wrappers, clients,
            // repositories — contributed no nodes and no calls before this.
            for (const c of cls.getConstructors()) addMember('constructor', c, 'constructor', exported);
            for (const g of cls.getGetAccessors()) addMember(g.getName(), g, 'getter', exported);
            for (const s of cls.getSetAccessors()) addMember(s.getName(), s, 'setter', exported);

            classes.push({ name: className, methods });
            this.index(className, classId, cls);
        }

        this.attachPrototypeAssignments(file, rel, classes);
        return classes;
    }

    /** CommonJS `Foo.prototype.bar = function () {}` */
    private attachPrototypeAssignments(file: SourceFile, rel: string, classes: VerisClass[]): void {
        try {
            for (const bin of file.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
                if (bin.getOperatorToken().getText() !== '=') continue;
                const left = bin.getLeft();
                if (left.getKind() !== SyntaxKind.PropertyAccessExpression) continue;
                // Case-insensitive initial: the previous `[A-Z]` requirement silently
                // dropped every lowercase-constructor codebase.
                const m = left.getText().match(/^([A-Za-z_$][\w$]*)\.prototype\.([\w$]+)$/);
                if (!m) continue;
                const [, className, methodName] = m;
                const right = bin.getRight();
                const k = right.getKind();
                if (k !== SyntaxKind.FunctionExpression && k !== SyntaxKind.ArrowFunction) continue;

                let cls = classes.find(c => c.name === className);
                if (!cls) {
                    cls = { name: className, methods: [] };
                    classes.push(cls);
                    this.index(className, `${rel}::${className}`, bin);
                }
                if (cls.methods.some(x => x.name === methodName)) continue;
                const memberId = `${rel}::${className}::${methodName}`;
                cls.methods.push({
                    name: methodName,
                    isExported: true,
                    kind: 'method',
                    bodyHash: this.hashBody(right),
                    calls: this.collectCallNodes(right) as any
                });
                this.index(methodName, memberId, right);
            }
        } catch {
            // resilient
        }
    }

    private extractFunctions(file: SourceFile, rel: string, classes: VerisClass[]): VerisFunction[] {
        const functions: VerisFunction[] = [];
        const seen = new Set<string>();
        const classNames = new Set(classes.map(c => c.name));

        const push = (name: string, node: Node, isExported: boolean) => {
            if (seen.has(name) || classNames.has(name)) return;
            seen.add(name);
            functions.push({
                name,
                isExported,
                bodyHash: this.hashBody(node),
                calls: this.collectCallNodes(node) as any
            });
            this.index(name, `${rel}::${name}`, node);
        };

        for (const fn of file.getFunctions()) {
            const name = fn.getName();
            if (name) push(name, fn, fn.isExported());
        }

        // `const X = function () {}` / `const X = () => {}` — top level only.
        try {
            for (const varDecl of file.getVariableDeclarations()) {
                const init = varDecl.getInitializer();
                if (!init) continue;
                const k = init.getKind();
                if (k !== SyntaxKind.FunctionExpression && k !== SyntaxKind.ArrowFunction) continue;
                // `getVariableDeclarations()` returns only top-level declarations, which
                // is the restriction the previous descendant walk claimed in a comment
                // but never enforced — every callback and closure became a graph node.
                const stmt = varDecl.getVariableStatement();
                push(varDecl.getName(), init, stmt ? stmt.isExported() : false);
            }
        } catch {
            // resilient
        }

        // `module.exports.X = fn` / `exports.X = fn` / `module.exports = fn`
        try {
            for (const bin of file.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
                if (bin.getOperatorToken().getText() !== '=') continue;
                const right = bin.getRight();
                const k = right.getKind();
                if (k !== SyntaxKind.FunctionExpression && k !== SyntaxKind.ArrowFunction) continue;

                const leftText = bin.getLeft().getText();
                if (leftText === 'module.exports' || leftText === 'exports') {
                    push(file.getBaseNameWithoutExtension(), right, true);
                    continue;
                }
                if (bin.getLeft().getKind() !== SyntaxKind.PropertyAccessExpression) continue;
                const m = leftText.match(/^(?:module\.)?exports\.([\w$]+)$/);
                if (m) push(m[1], right, true);
            }
        } catch {
            // resilient
        }

        return functions;
    }

    // ------------------------------------------------------------- call resolution

    /**
     * Pass one: record the call expression nodes. Resolution happens in pass two,
     * once every declaration in the repository has been indexed, so a call to a
     * symbol declared later in the traversal still resolves.
     */
    private collectCallNodes(node: Node): Node[] {
        try {
            return node.getDescendantsOfKind(SyntaxKind.CallExpression);
        } catch {
            return [];
        }
    }

    private resolveCallsForFile(classes: VerisClass[], functions: VerisFunction[]): void {
        const all: VerisFunction[] = [...functions];
        for (const c of classes) all.push(...c.methods);
        for (const fn of all) {
            const nodes = (fn.calls as unknown as Node[]) || [];
            fn.calls = this.resolveCalls(nodes);
        }
    }

    /**
     * Ask the TypeScript checker what each call actually points at.
     *
     * The previous implementation took `expr.getText().split('.').pop()` and drew an
     * edge to every declaration sharing that trailing name — so `console.log()`
     * produced an edge to the project's own `Logger.log`, and 91% of emitted edges
     * pointed at an ambiguous name. Resolution order here:
     *
     *   1. checker symbol → single declaration we indexed  → `resolved`
     *   2. checker symbol → declaration outside the source → `external` (no edge)
     *   3. no symbol, exactly one declaration by that name → `heuristic`
     *   4. no symbol, several candidates                   → `ambiguous` (no edge)
     */
    private resolveCalls(callNodes: Node[]): CallRef[] {
        const out: CallRef[] = [];
        const seen = new Set<string>();

        for (const call of callNodes) {
            let expr: Node;
            try {
                expr = (call as any).getExpression();
            } catch {
                continue;
            }

            const text = safeText(expr);
            const name = text.split('.').pop() || '';
            if (!/^[A-Za-z_$][\w$]*$/.test(name)) continue;

            let targetId: string | null = null;
            let resolution: CallResolution = 'ambiguous';

            const decl = this.resolveDeclaration(expr);
            if (decl === 'external') {
                resolution = 'external';
            } else if (decl) {
                targetId = decl;
                resolution = 'resolved';
            } else {
                const candidates = this.nameIndex.get(name);
                if (candidates && candidates.length === 1) {
                    targetId = candidates[0];
                    resolution = 'heuristic';
                } else if (!candidates || candidates.length === 0) {
                    resolution = 'external';
                }
            }

            const key = `${name}|${targetId ?? ''}|${resolution}`;
            if (seen.has(key)) continue;
            seen.add(key);

            switch (resolution) {
                case 'resolved':  this.stats.callsResolved++;  break;
                case 'heuristic': this.stats.callsHeuristic++; break;
                case 'ambiguous': this.stats.callsAmbiguous++; break;
                case 'external':  this.stats.callsExternal++;  break;
            }
            out.push({ name, targetId, resolution });
        }
        return out;
    }

    /**
     * Returns a node id when the checker resolves the call into indexed source,
     * the string `'external'` when it resolves outside it, or null when the checker
     * cannot tell (dynamic dispatch, `any`, untyped JS).
     */
    private resolveDeclaration(expr: Node): string | 'external' | null {
        let symbol;
        try {
            symbol = (expr as any).getSymbol?.();
            if (symbol && typeof symbol.getAliasedSymbol === 'function') {
                symbol = symbol.getAliasedSymbol() ?? symbol;
            }
        } catch {
            return null;
        }
        if (!symbol) return null;

        let decls: Node[] = [];
        try {
            decls = symbol.getDeclarations() ?? [];
        } catch {
            return null;
        }
        if (decls.length === 0) return null;

        for (const d of decls) {
            const id = this.lookupDeclaration(d);
            if (id) return id;
        }
        return 'external';
    }

    /** Walks up from a declaration to the nearest node we indexed. */
    private lookupDeclaration(decl: Node): string | null {
        let cur: Node | undefined = decl;
        for (let i = 0; cur && i < 6; i++) {
            const hit = this.declarationIndex.get(cur);
            if (hit) return hit;
            // `const x = () => {}` — the checker names the VariableDeclaration while we
            // indexed the initializer, so check it directly.
            try {
                const init = (cur as any).getInitializer?.();
                if (init) {
                    const viaInit = this.declarationIndex.get(init);
                    if (viaInit) return viaInit;
                }
            } catch {
                // not a declaration with an initializer
            }
            cur = cur.getParent();
        }
        return null;
    }

    private index(name: string, nodeId: string, decl: Node): void {
        const list = this.nameIndex.get(name);
        if (list) list.push(nodeId); else this.nameIndex.set(name, [nodeId]);
        this.declarationIndex.set(decl, nodeId);
    }

    // -------------------------------------------------------------------- hashing

    /**
     * Hash of the declaration with comments removed and whitespace collapsed, so
     * reformatting and comment edits do not register as behavioural change while a
     * genuine body rewrite does.
     */
    private hashBody(node: Node): string {
        let text: string;
        try {
            text = node.getText();
        } catch {
            return '';
        }
        const normalized = text
            .replace(/\/\*[\s\S]*?\*\//g, ' ')
            .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
            .replace(/\s+/g, ' ')
            .trim();
        return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
    }
}

function safeText(node: Node): string {
    try {
        return node.getText();
    } catch {
        return '';
    }
}

/** Exported for tests and for consumers that need the same ignore semantics. */
export { DEFAULT_IGNORED };
