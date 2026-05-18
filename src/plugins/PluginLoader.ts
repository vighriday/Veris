import * as fs from 'fs';
import * as path from 'path';
import { WorkflowKind } from '../models/WorkflowModels';

/**
 * Plugin Loader.
 *
 * Plugins live at `.veris/plugins/*.{js,mjs}`. Each module exports `register(api)`.
 * Plugins are local Node modules — no network, no sandbox. Trust model: same as
 * any package you `require()`. Disable with VERIS_PLUGINS_DISABLED=1.
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
    loadedPlugins: string[];
}

export function loadPlugins(projectRoot: string): PluginPayload {
    const payload: PluginPayload = {
        extraWorkflowRules: [], extraRuntimeRisks: {}, riskHeuristics: [],
        languageAdapters: [], loadedPlugins: []
    };
    if (process.env.VERIS_PLUGINS_DISABLED === '1') return payload;

    const dir = path.join(projectRoot, '.veris', 'plugins');
    if (!fs.existsSync(dir)) return payload;

    const api: PluginApi = {
        addWorkflowRule: (rule) => payload.extraWorkflowRules.push(rule),
        addRuntimeRisks: (kind, risks) => {
            payload.extraRuntimeRisks[kind] = (payload.extraRuntimeRisks[kind] || []).concat(risks);
        },
        addRiskHeuristic: (fn) => payload.riskHeuristics.push(fn),
        addLanguageAdapter: (a) => payload.languageAdapters.push(a),
        log: (msg) => console.error('[veris-plugin]', msg)
    };

    const entries = fs.readdirSync(dir).filter(f => /\.(js|mjs|cjs)$/.test(f));
    for (const entry of entries) {
        const abs = path.join(dir, entry);
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
