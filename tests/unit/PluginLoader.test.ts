import { describe, it, expect, afterAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { loadPlugins } from '../../src/plugins/PluginLoader';
import { tmpDir, writeFile, cleanupAll } from './tmpRepo';

afterAll(cleanupAll);
afterEach(() => { delete process.env.VERIS_ENABLE_PLUGINS; });

/**
 * A plugin that records the fact it executed by writing a file. Checking for that
 * file is the only honest way to assert whether code ran: asserting on the returned
 * payload alone would pass even if `register()` were never called.
 */
function markerPlugin(markerPath: string): string {
    return `
        const fs = require('fs');
        module.exports.register = function (api) {
            fs.writeFileSync(${JSON.stringify(markerPath)}, 'executed', 'utf8');
            api.addWorkflowRule({ kind: 'Billing', pathTokens: ['invoices'] });
        };
    `;
}

function repoWithPlugin(): { root: string; marker: string } {
    const root = tmpDir('veris-plugin-');
    const marker = path.join(root, 'EXECUTED.txt').replace(/\\/g, '/');
    writeFile(root, '.veris/plugins/evil.js', markerPlugin(marker));
    return { root, marker };
}

describe('PluginLoader — execution is opt-in', () => {
    // Finding D1: `.veris/plugins/*.js` from the ANALYZED repository was require()d
    // by default, with no sandbox, reachable from read-shaped tools. Pointing an
    // agent at an untrusted repository executed that repository's code. SECURITY.md
    // stated "It does not execute user code."
    it('does not execute a plugin by default', () => {
        const { root, marker } = repoWithPlugin();
        const payload = loadPlugins(root);

        expect(fs.existsSync(marker)).toBe(false);
        expect(payload.loadedPlugins).toEqual([]);
        expect(payload.extraWorkflowRules).toEqual([]);
    });

    it('discloses that plugins are present, with their hashes', () => {
        const { root } = repoWithPlugin();
        const payload = loadPlugins(root);

        expect(payload.discoveredPlugins).toHaveLength(1);
        expect(payload.discoveredPlugins[0].file).toBe('evil.js');
        expect(payload.discoveredPlugins[0].sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(payload.warnings.join(' ')).toMatch(/NOT executed/);
    });

    it('executes only when explicitly allowed', () => {
        const { root, marker } = repoWithPlugin();
        const payload = loadPlugins(root, { allowExecution: true });

        expect(fs.existsSync(marker)).toBe(true);
        expect(payload.loadedPlugins).toEqual(['evil.js']);
        expect(payload.extraWorkflowRules).toHaveLength(1);
    });

    it('honours the environment opt-in', () => {
        const { root, marker } = repoWithPlugin();
        process.env.VERIS_ENABLE_PLUGINS = '1';
        loadPlugins(root);
        expect(fs.existsSync(marker)).toBe(true);
    });

    it('reports the same hash for identical content and a different one otherwise', () => {
        const a = repoWithPlugin();
        const b = repoWithPlugin();
        // Same generated source apart from the embedded marker path, so hashes differ —
        // which is the property that matters: content changes are visible.
        const hashA = loadPlugins(a.root).discoveredPlugins[0].sha256;
        const hashB = loadPlugins(b.root).discoveredPlugins[0].sha256;
        expect(hashA).not.toBe(hashB);

        const again = loadPlugins(a.root).discoveredPlugins[0].sha256;
        expect(again).toBe(hashA);
    });
});

describe('PluginLoader — no plugins present', () => {
    it('returns an empty payload with no warnings', () => {
        const root = tmpDir('veris-noplugin-');
        const payload = loadPlugins(root);
        expect(payload.discoveredPlugins).toEqual([]);
        expect(payload.warnings).toEqual([]);
        expect(payload.loadedPlugins).toEqual([]);
    });
});

describe('PluginLoader — API validation', () => {
    it('rejects a malformed workflow rule without taking the process down', () => {
        const root = tmpDir('veris-badplugin-');
        writeFile(root, '.veris/plugins/bad.js', `
            module.exports.register = function (api) {
                api.addWorkflowRule({});                       // no kind
                api.addWorkflowRule({ kind: 'X', pathTokens: 'not-an-array' });
                api.addRuntimeRisks('', ['x']);                 // empty kind
                api.addWorkflowRule({ kind: 'Good', pathTokens: ['ok'] });
            };
        `);
        const payload = loadPlugins(root, { allowExecution: true });
        expect(payload.loadedPlugins).toEqual(['bad.js']);
        expect(payload.extraWorkflowRules.map(r => r.kind)).toEqual(['Good']);
    });

    it('survives a plugin that throws', () => {
        const root = tmpDir('veris-throwplugin-');
        writeFile(root, '.veris/plugins/boom.js', `
            module.exports.register = function () { throw new Error('boom'); };
        `);
        const payload = loadPlugins(root, { allowExecution: true });
        expect(payload.loadedPlugins).toEqual([]);
    });

    it('skips a module with no register export', () => {
        const root = tmpDir('veris-noreg-');
        writeFile(root, '.veris/plugins/inert.js', `module.exports.somethingElse = 1;`);
        const payload = loadPlugins(root, { allowExecution: true });
        expect(payload.loadedPlugins).toEqual([]);
        expect(payload.discoveredPlugins).toHaveLength(1);
    });
});
