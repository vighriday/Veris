"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RepositoryIntelligenceEngine = void 0;
const ts_morph_1 = require("ts-morph");
/**
 * Phase 1: Repository Intelligence Engine
 * Responsible for ingesting a repository, extracting AST data,
 * and mapping basic entity relationships and dependencies.
 */
class RepositoryIntelligenceEngine {
    projectRoot;
    project;
    constructor(projectRoot) {
        this.projectRoot = projectRoot;
        // Initialize ts-morph project
        this.project = new ts_morph_1.Project();
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
    analyze() {
        const sourceFiles = this.project.getSourceFiles();
        const report = {
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
    extractFileData(file) {
        const filePath = file.getFilePath();
        // Extract dependencies (imports)
        const imports = file.getImportDeclarations().map(imp => imp.getModuleSpecifierValue());
        // Extract classes and their methods
        const classes = file.getClasses().map(cls => {
            return {
                name: cls.getName() || 'AnonymousClass',
                methods: cls.getMethods().map(method => ({
                    name: method.getName(),
                    isExported: cls.isExported()
                }))
            };
        });
        // Extract standalone functions
        const functions = file.getFunctions().map(func => {
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
exports.RepositoryIntelligenceEngine = RepositoryIntelligenceEngine;
