export interface VerisFile {
    filePath: string;
    classes: VerisClass[];
    functions: VerisFunction[];
    imports: string[];
}

export interface VerisClass {
    name: string;
    methods: VerisFunction[];
}

export interface VerisFunction {
    name: string;
    isExported: boolean;
    calls?: string[];
}

export interface RepositoryIntelligenceReport {
    projectPath: string;
    files: VerisFile[];
    dependencyMap: Record<string, string[]>;
}
