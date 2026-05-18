import * as fs from 'fs';
import * as path from 'path';

/**
 * DataLoader — resolves default data files shipped under data/ at the package
 * root, and optionally merges per-repo overrides from `<project>/.veris/data/`.
 *
 * Override semantics:
 *  - For object-valued data (workflowRiskTexts, probesByKind, riskConfig, criticality),
 *    the override is a deep merge over the default.
 *  - For array-valued data (workflowRules), the override REPLACES the default
 *    unless an `extend: true` flag is set on the user file, in which case the
 *    user array is concatenated.
 *
 * Resolution order:
 *  1. Package-shipped default at `<package_root>/data/<name>.json` (built into npm tarball).
 *  2. Per-repo override at `<project_root>/.veris/data/<name>.json`.
 */

export interface WorkflowRuleData {
    kind: string;
    pathTokens?: string[];
    importTokens?: string[];
    symbolTokens?: string[];
    weight?: number;
}

export interface RuntimeRiskData { [kind: string]: string[]; }

export interface ProbeTemplate {
    category: string;
    scenario: string;
    expectedInvariant: string;
    severity: 'low' | 'medium' | 'high';
}
export interface ProbeDataFile {
    probesByKind: { [kind: string]: ProbeTemplate[] };
    generic: ProbeTemplate[];
}

export interface RiskConfig {
    risk: {
        blastRadiusPerEdge: number;
        blastRadiusMax: number;
        fragilityLog2Coefficient: number;
        criticalityBase: number;
        criticalityEnginePatternBonus: number;
        criticalityHighImpactPatternBonus: number;
        criticalityHighImpactPathBonus: number;
        criticalityMax: number;
        weights: { blastRadius: number; runtimeCriticality: number; dependencyFragility: number };
        patterns: { enginePattern: string; highImpactPattern: string; highImpactPathSegments: string[] };
    };
    confidence: {
        halfLifeDays: number;
        tierWeight: { [tier: string]: number };
        riskPenaltyCoefficient: number;
        missingExecutionPenaltyCoefficient: number;
        failurePenaltyPerTierWeight: number;
        flakyHalfCreditPenalty: number;
        failurePenaltyCap: number;
        fragilityAssumptionThreshold: number;
    };
    budget: {
        tierLeverage: { [tier: string]: number };
        tierCostSeconds: { [tier: string]: number };
        workflowCriticality: { [kind: string]: number };
    };
}

let packageDataDir: string | null = null;
function getPackageDataDir(): string {
    if (packageDataDir) return packageDataDir;
    // dist/data/DataLoader.js -> dist/data/.. = dist -> dist/.. = package root
    const here = __dirname;
    const candidates = [
        path.join(here, '..', '..', 'data'),
        path.join(here, '..', 'data'),
        path.join(here, 'data')
    ];
    for (const c of candidates) if (fs.existsSync(c)) { packageDataDir = c; return c; }
    throw new Error('veris: could not locate shipped data/ directory');
}

function readJson<T>(filePath: string): T | null {
    try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        return JSON.parse(raw) as T;
    } catch {
        return null;
    }
}

function userOverridePath(projectRoot: string, name: string): string {
    return path.join(projectRoot, '.veris', 'data', name);
}

function deepMerge<T>(base: T, over: any): T {
    if (over === null || over === undefined) return base;
    if (Array.isArray(base) && Array.isArray(over)) return over as any;
    if (typeof base === 'object' && base !== null && typeof over === 'object' && !Array.isArray(over)) {
        const out: any = { ...(base as any) };
        for (const k of Object.keys(over)) {
            out[k] = (k in out) ? deepMerge(out[k], over[k]) : over[k];
        }
        return out;
    }
    return over as T;
}

export function loadWorkflowRules(projectRoot: string): WorkflowRuleData[] {
    const def = readJson<{ rules: WorkflowRuleData[] }>(path.join(getPackageDataDir(), 'workflow-rules.json'));
    const defaults = def?.rules ?? [];
    const user = readJson<{ rules?: WorkflowRuleData[]; extend?: boolean }>(userOverridePath(projectRoot, 'workflow-rules.json'));
    if (!user || !user.rules) return defaults;
    return user.extend ? defaults.concat(user.rules) : user.rules;
}

export function loadRuntimeRisks(projectRoot: string): RuntimeRiskData {
    const def = readJson<{ risks: RuntimeRiskData }>(path.join(getPackageDataDir(), 'runtime-risks.json'));
    const defaults = def?.risks ?? {};
    const user = readJson<{ risks?: RuntimeRiskData }>(userOverridePath(projectRoot, 'runtime-risks.json'));
    if (!user?.risks) return defaults;
    return deepMerge(defaults, user.risks);
}

export function loadProbes(projectRoot: string): ProbeDataFile {
    const def = readJson<ProbeDataFile>(path.join(getPackageDataDir(), 'probes.json')) ?? { probesByKind: {}, generic: [] };
    const user = readJson<Partial<ProbeDataFile>>(userOverridePath(projectRoot, 'probes.json'));
    if (!user) return def;
    return {
        probesByKind: deepMerge(def.probesByKind, user.probesByKind),
        generic: user.generic ?? def.generic
    };
}

export function loadRiskConfig(projectRoot: string): RiskConfig {
    const def = readJson<RiskConfig>(path.join(getPackageDataDir(), 'risk-config.json'));
    if (!def) throw new Error('veris: data/risk-config.json missing from package');
    const user = readJson<Partial<RiskConfig>>(userOverridePath(projectRoot, 'risk-config.json'));
    if (!user) return def;
    return deepMerge(def, user);
}
