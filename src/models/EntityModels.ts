/**
 * How a call target was determined.
 *
 *  - `resolved`  — the TypeScript checker named a single declaration. Trustworthy.
 *  - `heuristic` — the checker could not resolve it, but exactly one declaration in
 *                  the repository carries that name, so the mapping is unambiguous.
 *  - `ambiguous` — several declarations share the name and nothing distinguishes them.
 *                  Recorded for reporting; never emitted as a graph edge.
 *  - `external`  — resolves outside the analyzed source (node_modules, lib.d.ts).
 */
export type CallResolution = 'resolved' | 'heuristic' | 'ambiguous' | 'external';

export interface CallRef {
    /** Trailing identifier of the call expression, kept for diagnostics. */
    name: string;
    /** Node id of the resolved target, or null when unresolved/external. */
    targetId: string | null;
    resolution: CallResolution;
}

export type MemberKind = 'method' | 'constructor' | 'getter' | 'setter';

export interface VerisFile {
    /**
     * Project-root-relative, POSIX-separated: `src/auth/login.ts`.
     *
     * Node ids are built from this, so they are stable across machines, clones,
     * CI checkouts and the temporary worktree used for the base snapshot. It is
     * also why the base snapshot needs no path rewriting: analyzing the same file
     * under a different root produces the same id.
     */
    filePath: string;
    /** Absolute on-disk path. For file IO only — never for identity. */
    absPath: string;
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
    calls?: CallRef[];
    /**
     * SHA-256 of the declaration body with comments and whitespace normalized out.
     * Lets a fingerprint notice a rewritten body that kept its name and its callees —
     * the "silent rewrite" case name-and-topology hashing cannot see.
     */
    bodyHash?: string;
    kind?: MemberKind;
}

export interface AnalysisStats {
    filesAnalyzed: number;
    filesSkipped: number;
    callsResolved: number;
    callsHeuristic: number;
    callsAmbiguous: number;
    callsExternal: number;
    truncated: boolean;
}

export interface RepositoryIntelligenceReport {
    projectPath: string;
    files: VerisFile[];
    /**
     * @deprecated Kept for the plugin API surface. Consumers must read
     * `file.imports` instead: this map was keyed by path in a way that silently
     * desynchronized from `filePath` whenever the analysis root differed from the
     * reporting root, which zeroed out every import edge in the base snapshot.
     */
    dependencyMap: Record<string, string[]>;
    stats: AnalysisStats;
}
