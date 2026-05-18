# Contributing to Veris

Thanks for considering a contribution. Veris is fully open source, sponsor-funded, and MCP-native. No paid tier. No gated features.

## Where the value is

Veris is **verification intelligence infrastructure**, not a test runner. Contributions that strengthen the intelligence layer beat contributions that add execution scope. Examples:

Welcome:

- Language adapters for non-TS/JS ecosystems (Python, Go, Rust, Java, C#).
- Framework adapters (Express, Next.js, NestJS, Django, FastAPI, Rails routes).
- Workflow classifier rules for new verticals (gaming, healthcare, IoT, defense, etc.).
- Risk heuristics keyed to specific runtime patterns (sagas, CRDT sync, event-sourcing).
- Adversarial probe templates for new workflow kinds.
- Cross-repo analysis improvements (workflow stitching across services).
- Performance: incremental indexing, parallel AST parsing.

Out of scope:

- Test runners or browser automation (use Playwright/Vitest/CI for execution).
- Cloud SaaS endpoints / hosted dashboards.
- License gating, telemetry hooks, paywalled features.

## Plugin development

Plugins live at `<repo>/.veris/plugins/*.{js,mjs,cjs}`. Each exports `register(api)`. Plugins are local Node modules — same trust model as anything `require()`d.

Plugin API surface:

```js
module.exports.register = function (api) {
    api.addWorkflowRule({
        kind: 'Payments',                  // any string; built-ins are WorkflowKind values
        pathTokens: ['stripe-internal'],
        importTokens: ['@yourorg/billing-sdk'],
        symbolTokens: ['invoiceLineItem'],
        weight: 2                          // default 1
    });

    api.addRuntimeRisks('Payments', [
        'currency rounding mismatch across legs'
    ]);

    api.addRiskHeuristic((ctx) => {
        // ctx: { riskReport, node, graph }
        // Return null to skip, or RiskHeuristicPatch to adjust.
        if (ctx.node.label.endsWith('Migration')) {
            return { nodeId: ctx.node.id, deltas: { runtimeCriticality: +20 }, explanation: 'Schema migration: criticality boost.' };
        }
        return null;
    });

    api.addLanguageAdapter({
        name: 'python',
        extensions: ['.py'],
        analyze(projectRoot) { /* return RepositoryIntelligenceReport-shaped data */ }
    });
};
```

Disable all plugin loading: `VERIS_PLUGINS_DISABLED=1`.

## Local development

```bash
git clone https://github.com/<owner>/veris
cd veris
npm install
npm run build
node dist/cli.js .
```

For MCP development:

```bash
npm run build && npx ts-node tests/test-mcp-deep.ts
```

## Pull requests

- Keep PRs small. The first review pass looks at scope.
- Update CHANGELOG.md under `## [Unreleased]`.
- New engines belong in `src/engine/`. New persistence belongs in `src/persistence/`. New MCP tools belong in `src/mcp/McpServer.ts`.
- Add a smoke test if the change touches the CLI surface or an MCP tool.

## Reporting issues

Include:

- Veris version (`npx veris help` shows version)
- Output of `node --version`
- A minimal repo that reproduces the issue, or a redacted `.veris/state.db` (the schema is documented).
- For MCP issues: which client (Claude Code, Cursor, ...) and the request/response from your client's logs.

## Sponsorship

Veris is sponsor-funded. If your company uses Veris in production, consider sponsoring on GitHub Sponsors / Open Collective / direct. No features are sponsor-gated.
