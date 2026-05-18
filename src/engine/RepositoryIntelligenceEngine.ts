import { Project, SourceFile } from 'ts-morph';
import { BVIFile, BVIClass, BVIFunction, RepositoryIntelligenceReport } from '../models/EntityModels';

/**
 * Phase 1: Repository Intelligence Engine
 * Responsible for ingesting a repository, extracting AST data,
 * and mapping basic entity relationships and dependencies.
 */
export class RepositoryIntelligenceEngine {
    private project: Project;

    constructor(private projectRoot: string) {
        // Initialize ts-morph project
        this.project = new Project();
        
        // Add files to project. We scan for .ts and .js files recursively.
        // In a real environment, we'd ignore node_modules and dist heavily, 
        // ts-morph handles node_modules exclusion by default when explicitly adding paths or we do it manually.
        this.project.addSourceFilesAtPaths([
            `${projectRoot}/**/*.ts`,
            `${projectRoot}/**/*.js`,
            `!${projectRoot}/node_modules/**/*`,
            `!${projectRoot}/dist/**/*`
        ]);
    }

    public analyze(): RepositoryIntelligenceReport {
        const sourceFiles = this.project.getSourceFiles();
        
        const report: RepositoryIntelligenceReport = {
            projectPath: this.projectRoot,
            files: [],
            dependencyMap: {}
        };

        for (const file of sourceFiles) {
            const bviFile = this.extractFileData(file);
            report.files.push(bviFile);
            report.dependencyMap[bviFile.filePath] = bviFile.imports;
        }

        return report;
    }

    private extractFileData(file: SourceFile): BVIFile {
        const filePath = file.getFilePath();
        
        // Extract dependencies (imports)
        const imports = file.getImportDeclarations().map(imp => imp.getModuleSpecifierValue());

        // Extract classes and their methods
        const classes: BVIClass[] = file.getClasses().map(cls => {
            return {
                name: cls.getName() || 'AnonymousClass',
                methods: cls.getMethods().map(method => ({
                    name: method.getName(),
                    isExported: cls.isExported()
                }))
            };
        });

        // Extract standalone functions
        const functions: BVIFunction[] = file.getFunctions().map(func => {
            return {
                name: func.getName() || 'AnonymousFunction',
                isExported: func.isExported()
            };
        });

        return {
            filePath,
            classes,
            functions,
            imports
        };
    }
}
