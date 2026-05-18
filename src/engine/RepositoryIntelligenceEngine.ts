import { Project, SourceFile, SyntaxKind, Node } from 'ts-morph';
import { VerisFile, VerisClass, VerisFunction, RepositoryIntelligenceReport } from '../models/EntityModels';
import { SecurityBaselineConfig } from '../models/ArchitectureModels';

/**
 * Repository Intelligence Engine.
 *
 * Ingests TypeScript or JavaScript source via ts-morph. Extracts:
 *  - imports (ES `import` + CommonJS `require()`)
 *  - classes (incl. methods, prototype assignments)
 *  - functions (declarations + `const fn = function/() => {}` + `module.exports.x = function() {}`)
 *  - per-symbol callee names from CallExpressions
 *
 * Supports both modern TS/JS and legacy CommonJS patterns (Express, Koa, etc.).
 */
export class RepositoryIntelligenceEngine {
    private project: Project;
    private security: SecurityBaselineConfig;

    constructor(private projectRoot: string, security?: Partial<SecurityBaselineConfig>) {
        this.security = {
            zeroRetentionMode: security?.zeroRetentionMode ?? true,
            airGapped: security?.airGapped ?? true,
            ignoredPaths: security?.ignoredPaths ?? ['node_modules', 'dist', '.git', 'veris-reports', 'bvi-reports', 'coverage', '.next', 'build']
        };

        this.project = new Project({
            useInMemoryFileSystem: false,
            // Don't try to type-check; we just want AST. Massive perf win on big repos.
            compilerOptions: { allowJs: true, checkJs: false, noEmit: true, skipLibCheck: true }
        });

        const includes = [`${projectRoot}/**/*.ts`, `${projectRoot}/**/*.tsx`, `${projectRoot}/**/*.js`, `${projectRoot}/**/*.jsx`, `${projectRoot}/**/*.mjs`, `${projectRoot}/**/*.cjs`];
        const excludes = this.security.ignoredPaths.map(p => `!${projectRoot}/${p}/**/*`);
        this.project.addSourceFilesAtPaths([...includes, ...excludes]);
    }

    public analyze(): RepositoryIntelligenceReport {
        const sourceFiles = this.project.getSourceFiles();

        const report: RepositoryIntelligenceReport = {
            projectPath: this.projectRoot,
            files: [],
            dependencyMap: {}
        };

        for (const file of sourceFiles) {
            const verisFile = this.extractFileData(file);
            report.files.push(verisFile);
            report.dependencyMap[verisFile.filePath] = verisFile.imports;
        }

        return report;
    }

    private extractFileData(file: SourceFile): VerisFile {
        const filePath = file.getFilePath();
        const imports = this.extractImports(file);
        const classes = this.extractClasses(file);
        const functions = this.extractFunctions(file, classes);
        return { filePath, classes, functions, imports };
    }

    private extractImports(file: SourceFile): string[] {
        const out = new Set<string>();
        // ES imports
        for (const imp of file.getImportDeclarations()) {
            const spec = imp.getModuleSpecifierValue();
            if (spec) out.add(spec);
        }
        // CommonJS require() calls
        try {
            for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
                const callee = call.getExpression();
                if (callee.getText() !== 'require') continue;
                const args = call.getArguments();
                if (args.length === 0) continue;
                const first = args[0];
                if (first.getKind() === SyntaxKind.StringLiteral) {
                    const txt = first.getText();
                    // Strip quotes
                    out.add(txt.replace(/^['"`]|['"`]$/g, ''));
                }
            }
        } catch {
            // resilient
        }
        return Array.from(out);
    }

    private extractClasses(file: SourceFile): VerisClass[] {
        const classes: VerisClass[] = file.getClasses().map(cls => ({
            name: cls.getName() || 'AnonymousClass',
            methods: cls.getMethods().map(method => ({
                name: method.getName(),
                isExported: cls.isExported(),
                calls: this.extractCalls(method)
            }))
        }));

        // CommonJS prototype assignments: ClassName.prototype.method = function() {}
        // Group by class name, attach methods.
        try {
            const protoAssignments = new Map<string, { methodName: string; node: Node }[]>();
            for (const bin of file.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
                if (bin.getOperatorToken().getText() !== '=') continue;
                const left = bin.getLeft();
                if (left.getKind() !== SyntaxKind.PropertyAccessExpression) continue;
                const leftText = left.getText();
                // Match `Foo.prototype.bar`
                const m = leftText.match(/^([A-Z][\w$]*)\.prototype\.([\w$]+)$/);
                if (!m) continue;
                const [, className, methodName] = m;
                const right = bin.getRight();
                if (right.getKind() !== SyntaxKind.FunctionExpression && right.getKind() !== SyntaxKind.ArrowFunction) continue;
                if (!protoAssignments.has(className)) protoAssignments.set(className, []);
                protoAssignments.get(className)!.push({ methodName, node: right });
            }
            protoAssignments.forEach((methods, className) => {
                let cls = classes.find(c => c.name === className);
                if (!cls) {
                    cls = { name: className, methods: [] };
                    classes.push(cls);
                }
                for (const m of methods) {
                    if (cls.methods.find(x => x.name === m.methodName)) continue;
                    cls.methods.push({
                        name: m.methodName,
                        isExported: true,
                        calls: this.extractCalls(m.node as any)
                    });
                }
            });
        } catch {
            // ignore
        }

        return classes;
    }

    private extractFunctions(file: SourceFile, classes: VerisClass[]): VerisFunction[] {
        const functions: VerisFunction[] = [];
        const seen = new Set<string>();
        const classNames = new Set(classes.map(c => c.name));

        // Function declarations
        for (const fn of file.getFunctions()) {
            const name = fn.getName();
            if (!name) continue;
            if (seen.has(name)) continue;
            seen.add(name);
            functions.push({ name, isExported: fn.isExported(), calls: this.extractCalls(fn) });
        }

        // const X = function/() => ...   AND   var X = function/() => ...   AND   let X = ...
        try {
            for (const varDecl of file.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
                const name = varDecl.getName();
                if (!name || seen.has(name) || classNames.has(name)) continue;
                const init = varDecl.getInitializer();
                if (!init) continue;
                const k = init.getKind();
                if (k !== SyntaxKind.FunctionExpression && k !== SyntaxKind.ArrowFunction) continue;
                // Only top-level (parent.parent.parent should be SourceFile via VariableStatement)
                seen.add(name);
                functions.push({ name, isExported: true, calls: this.extractCalls(init as any) });
            }
        } catch {
            // ignore
        }

        // module.exports.X = function() {} OR exports.X = function() {}
        try {
            for (const bin of file.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
                if (bin.getOperatorToken().getText() !== '=') continue;
                const left = bin.getLeft();
                if (left.getKind() !== SyntaxKind.PropertyAccessExpression) continue;
                const leftText = left.getText();
                let propName: string | null = null;
                const m1 = leftText.match(/^module\.exports\.([\w$]+)$/);
                const m2 = leftText.match(/^exports\.([\w$]+)$/);
                if (m1) propName = m1[1];
                else if (m2) propName = m2[1];
                if (!propName || seen.has(propName) || classNames.has(propName)) continue;
                const right = bin.getRight();
                const k = right.getKind();
                if (k !== SyntaxKind.FunctionExpression && k !== SyntaxKind.ArrowFunction) continue;
                seen.add(propName);
                functions.push({ name: propName, isExported: true, calls: this.extractCalls(right as any) });
            }
            // `module.exports = function NAMED() {}` -> create a function with the file's base name
            const baseFnExports = file.getDescendantsOfKind(SyntaxKind.BinaryExpression).filter(b => {
                if (b.getOperatorToken().getText() !== '=') return false;
                const lt = b.getLeft().getText();
                return lt === 'module.exports' || lt === 'exports';
            });
            for (const b of baseFnExports) {
                const right = b.getRight();
                const k = right.getKind();
                if (k !== SyntaxKind.FunctionExpression && k !== SyntaxKind.ArrowFunction) continue;
                // Use the file's base name (without extension) as the function name
                const base = file.getBaseNameWithoutExtension();
                if (seen.has(base) || classNames.has(base)) continue;
                seen.add(base);
                functions.push({ name: base, isExported: true, calls: this.extractCalls(right as any) });
            }
        } catch {
            // ignore
        }

        return functions;
    }

    private extractCalls(node: any): string[] {
        const calls: Set<string> = new Set();
        try {
            const callExprs = node.getDescendantsOfKind(SyntaxKind.CallExpression);
            for (const c of callExprs) {
                const expr = c.getExpression();
                const text = expr.getText();
                const callee = text.split('.').pop();
                if (callee && /^[A-Za-z_$][\w$]*$/.test(callee)) calls.add(callee);
            }
        } catch {
            // resilient
        }
        return Array.from(calls);
    }
}
