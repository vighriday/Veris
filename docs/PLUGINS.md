# Veris Plugin Guide

Plugins extend Veris without forking. They live at `<repo>/.veris/plugins/*.{js,mjs,cjs}` and run in-process as local Node modules.

Trust model: same as `require()`. Veris does not sandbox plugins. Don't load plugins from sources you would not load any other Node module from.

## Quick start

```bash
veris init
ls .veris/plugins/
```

Rename `example.js.disabled` to `example.js`, then re-run `veris .`.

## API

```ts
interface PluginApi {
    addWorkflowRule(rule: ExternalWorkflowRule): void;
    addRuntimeRisks(kind: string, risks: string[]): void;
    addRiskHeuristic(fn: (ctx: HeuristicCtx) => RiskHeuristicPatch | null): void;
    addLanguageAdapter(adapter: LanguageAdapterPlugin): void;
    log(msg: string): void;
}

interface ExternalWorkflowRule {
    kind: string;              // 'Payments', 'Authentication', or any new string
    pathTokens?: string[];     // matched as case-insensitive substrings of file paths
    importTokens?: string[];   // matched as substrings of imported module specifiers
    symbolTokens?: string[];   // matched against class/method/function names (lowercased)
    weight?: number;           // default 1; path matches are 2× weighted, imports 3×, symbols 1×
}
```

## Built-in WorkflowKinds

These are reserved kinds with built-in runtime risk templates:

`Authentication, Authorization, Session, Billing, Payments, Checkout, Cart, Notifications, Webhooks, Messaging, Realtime, Queue, Caching, Persistence, Sync, Search, Onboarding, Profile, Admin, Analytics, AI, Routing, Orchestration, Reporting, Configuration, Infrastructure, Core, Uncategorized`

Custom kinds work too — they appear in the dashboard, but without baseline runtime risks until you supply them with `addRuntimeRisks`.

## Examples

### Vertical reinforcement

```js
module.exports.register = function (api) {
    api.addWorkflowRule({
        kind: 'Payments',
        pathTokens: ['ledger', 'reconcile'],
        importTokens: ['stripe', '@adyen/'],
        weight: 3
    });
    api.addRuntimeRisks('Payments', [
        '3DS challenge response lost on tab close',
        'settlement file double-import on resubmit'
    ]);
};
```

### Custom kind

```js
module.exports.register = function (api) {
    api.addWorkflowRule({
        kind: 'IoTFleet',
        pathTokens: ['fleet', 'device'],
        importTokens: ['aws-iot-device-sdk', '@azure/event-hubs'],
        symbolTokens: ['provision', 'rotatecert', 'firmwareupdate']
    });
    api.addRuntimeRisks('IoTFleet', [
        'cert rotation race with intermittent device',
        'OTA rollback on partial firmware apply'
    ]);
};
```

### Risk heuristic

```js
module.exports.register = function (api) {
    api.addRiskHeuristic((ctx) => {
        if (ctx.node.label.toLowerCase().endsWith('migration')) {
            return {
                nodeId: ctx.node.id,
                deltas: { runtimeCriticality: 20 },
                explanation: 'Schema migration: criticality boost.'
            };
        }
        return null;
    });
};
```

## Disabling

`VERIS_PLUGINS_DISABLED=1` skips plugin loading entirely. Useful in CI when you want deterministic runs.

## Roadmap

- Plugin manifest (`veris-plugin.json`) for versioning and capability declarations.
- Plugin marketplace / index.
- TypeScript plugin support without precompile (currently `.js`/`.mjs`/`.cjs`).
- Hot-reload during `veris watch` (planned).
