export interface BVIFile {
    filePath: string;
    classes: BVIClass[];
    functions: BVIFunction[];
    imports: string[]; // Paths or modules imported
}

export interface BVIClass {
    name: string;
    methods: BVIFunction[];
}

export interface BVIFunction {
    name: string;
    isExported: boolean;
}

export interface RepositoryIntelligenceReport {
    projectPath: string;
    files: BVIFile[];
    dependencyMap: Record<string, string[]>; // Map of file to files/modules it imports
}
