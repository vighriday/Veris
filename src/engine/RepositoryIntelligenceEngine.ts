import { Project, SourceFile, SyntaxKind } from 'ts-morph';
import { VerisFile, VerisClass, VerisFunction, RepositoryIntelligenceReport } from '../models/EntityModels';
import { SecurityBaselineConfig } from '../models/ArchitectureModels';

/**
 * Phase 1: Repository Intelligence Engine
 * Ingests a repository, extracts AST, and maps entity relationships + call edges.
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

        this.project = new Project({ useInMemoryFileSystem: false });

        const includes = [`${projectRoot}/**/*.ts`, `${projectRoot}/**/*.js`];
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

        const imports = file.getImportDeclarations().map(imp => imp.getModuleSpecifierValue());

        const classes: VerisClass[] = file.getClasses().map(cls => {
            return {
                name: cls.getName() || 'AnonymousClass',
                methods: cls.getMethods().map(method => ({
                    name: method.getName(),
                    isExported: cls.isExported(),
                    calls: this.extractCalls(method)
                }))
            };
        });

        const functions: VerisFunction[] = file.getFunctions().map(func => {
            return {
                name: func.getName() || 'AnonymousFunction',
                isExported: func.isExported(),
                calls: this.extractCalls(func)
            };
        });

        return { filePath, classes, functions, imports };
    }

    private extractCalls(node: any): string[] {
        const calls: Set<string> = new Set();
        try {
            const callExprs = node.getDescendantsOfKind(SyntaxKind.CallExpression);
            for (const c of callExprs) {
                const expr = c.getExpression();
                const text = expr.getText();
                // Captures `foo()`, `obj.bar()`, `this.baz()` — last segment as callee name
                const callee = text.split('.').pop();
                if (callee && /^[A-Za-z_$][\w$]*$/.test(callee)) calls.add(callee);
            }
        } catch {
            // resilient against malformed nodes
        }
        return Array.from(calls);
    }
}
