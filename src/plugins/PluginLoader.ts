import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { WorkflowKind } from '../models/WorkflowModels';

/**
 * Plugin Loader.
 *
 * Plugins live at `<analyzed-repo>/.veris/plugins/*.{js,mjs,cjs}` and each module
 * exports `register(api)`.
 *
 * SECURITY — read before changing any default here.
 *
 * A plugin is arbitrary Node code that ships inside the repository being analyzed,
 * and it runs with the privileges of whoever invoked Veris. Veris' primary use is
 * pointing a coding agent at a repository the user may not have written, so loading
 * this automatically means "cloning a repo executes its code".
 *
 * Execution is therefore OFF by default and requires an explicit, per-run opt-in
 * (`--allow-plugins` or `VERIS_ENABLE_PLUGINS=1`). When plugins are present but not
 * enabled, the loader reports them and continues without executing anything. Every
 * executed plugin has its absolute path and SHA-256 printed before it runs, so the
 * action is attributable after the fact.
 *
 * This is not a sandbox and does not pretend to be one: `require()` grants full
 * process capability. The control is consent and disclosure, not containment.
 *
 * Plugin API (minimal, additive):
 *   api.addWorkflowRule({ kind, pathTokens, importTokens, symbolTokens, weight })
 *   api.addRuntimeRisks(kind, [...risks])
 *   api.addRiskHeuristic(fn) // (riskReport, node, graph) => optional patches
 *   api.addLanguageAdapter({ name, extensions, analyze(projectRoot) })
 */

export interface ExternalWorkflowRule {
    kind: string;            // any string; built-ins are WorkflowKind values
    pathTokens?: string[];
    importTokens?: string[];
    symbolTokens?: string[];
    weight?: number;
}

export interface RiskHeuristicPatch {
    nodeId: string;
    deltas: Partial<{ overallRisk: number; blastRadius: number; dependencyFragility: number; runtimeCriticality: number }>;
    explanation?: string;
}

export interface LanguageAdapterPlugin {
    name: string;
    extensions: string[];
    analyze: (projectRoot: string) => { files: any[]; dependencyMap: Record<string, string[]>; projectPath: string };
}

export interface PluginApi {
    addWorkflowRule(rule: ExternalWorkflowRule): void;
    addRuntimeRisks(kind: string, risks: string[]): void;
    addRiskHeuristic(fn: (ctx: { riskReport: any; node: any; graph: any }) => RiskHeuristicPatch | null): void;
    addLanguageAdapter(adapter: LanguageAdapterPlugin): void;
    log(msg: string): void;
}

export interface PluginPayload {
    extraWorkflowRules: ExternalWorkflowRule[];
    extraRuntimeRisks: Record<string, string[]>;
    riskHeuristics: Array<(ctx: { riskReport: any; node: any; graph: any }) => RiskHeuristicPatch | null>;
    languageAdapters: LanguageAdapterPlugin[];
    /** Plugins actually executed this run. Empty unless execution was opted into. */
    loadedPlugins: string[];
    /** Plugins present on disk but not executed, with their hashes. */
    discoveredPlugins: Array<{ file: string; sha256: string }>;
    warnings: string[];
}

export interface LoadPluginsOptions {
    /**
     * Execute discovered plugins. Defaults to false — see the security note at the
     * top of this file. `VERIS_ENABLE_PLUGINS=1` sets this for the process.
     */
    allowExecution?: boolean;
}

export function loadPlugins(projectRoot: string, options: LoadPluginsOptions = {}): PluginPayload {
    const payload: PluginPayload = {
        extraWorkflowRules: [], extraRuntimeRisks: {}, riskHeuristics: [],
        languageAdapters: [], loadedPlugins: [], discoveredPlugins: [], warnings: []
    };

    const dir = path.join(projectRoot, '.veris', 'plugins');
    if (!fs.existsSync(dir)) return payload;

    const entries = fs.readdirSync(dir).filter(f => /\.(js|mjs|cjs)$/.test(f));
    if (entries.length === 0) return payload;

    for (const entry of entries) {
        payload.discoveredPlugins.push({ file: entry, sha256: hashFile(path.join(dir, entry)) });
    }

    const enabled = options.allowExecution === true || process.env.VERIS_ENABLE_PLUGINS === '1';
    if (!enabled) {
        payload.warnings.push(
            `${entries.length} plugin file(s) found in ${dir} but NOT executed. ` +
            `Plugins run arbitrary code from the analyzed repository. ` +
            `Pass --allow-plugins (or VERIS_ENABLE_PLUGINS=1) only if you trust this repository.`
        );
        return payload;
    }

    const isStringArray = (v: any) => Array.isArray(v) && v.every(x => typeof x === 'string');
    const api: PluginApi = {
        addWorkflowRule: (rule) => {
            if (!rule || typeof rule.kind !== 'string' || !rule.kind.trim()) {
                console.error('[veris-plugin] addWorkflowRule: missing or invalid kind, skipped');
                return;
            }
            if (rule.pathTokens && !isStringArray(rule.pathTokens)) { console.error('[veris-plugin] invalid pathTokens'); return; }
            if (rule.importTokens && !isStringArray(rule.importTokens)) { console.error('[veris-plugin] invalid importTokens'); return; }
            if (rule.symbolTokens && !isStringArray(rule.symbolTokens)) { console.error('[veris-plugin] invalid symbolTokens'); return; }
            payload.extraWorkflowRules.push(rule);
        },
        addRuntimeRisks: (kind, risks) => {
            if (typeof kind !== 'string' || !kind.trim()) { console.error('[veris-plugin] addRuntimeRisks: invalid kind'); return; }
            if (!isStringArray(risks)) { console.error('[veris-plugin] addRuntimeRisks: risks must be string[]'); return; }
            payload.extraRuntimeRisks[kind] = (payload.extraRuntimeRisks[kind] || []).concat(risks);
        },
        addRiskHeuristic: (fn) => {
            if (typeof fn !== 'function') { console.error('[veris-plugin] addRiskHeuristic: fn must be function'); return; }
            payload.riskHeuristics.push(fn);
        },
        addLanguageAdapter: (a) => {
            if (!a || typeof a.name !== 'string' || !isStringArray(a.extensions) || typeof a.analyze !== 'function') {
                console.error('[veris-plugin] addLanguageAdapter: invalid adapter shape');
                return;
            }
            payload.languageAdapters.push(a);
        },
        log: (msg) => console.error('[veris-plugin]', msg)
    };

    for (const entry of entries) {
        const abs = path.join(dir, entry);
        const sha = payload.discoveredPlugins.find(p => p.file === entry)?.sha256 ?? 'unknown';
        // Disclose before executing, not after: if the plugin crashes the process or
        // never returns, this line is still the record of what ran.
        console.error(`[veris-plugin] EXECUTING ${abs} (sha256:${sha.slice(0, 16)})`);
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const mod = require(abs);
            const register = mod.register || (mod.default && mod.default.register);
            if (typeof register !== 'function') {
                console.error(`[veris-plugin] ${entry} skipped: no register(api) export`);
                continue;
            }
            register(api);
            payload.loadedPlugins.push(entry);
        } catch (e) {
            console.error(`[veris-plugin] failed to load ${entry}: ${(e as Error).message}`);
        }
    }
    return payload;
}

function hashFile(abs: string): string {
    try {
        return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
    } catch {
        return 'unreadable';
    }
}
