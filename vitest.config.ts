import { defineConfig } from 'vitest/config';

// Unit tests exercise the engines directly against src/ (TypeScript), so a change
// is caught before it reaches dist/. The MCP integration check under tests/*.ts is
// driven separately by `npm run test:mcp:deep` — it spawns a built server, which is
// not a unit test.
//
// Coverage includes all of src/. It was previously scoped to src/engine/** only,
// which excluded the MCP server, persistence, reporting, CLI and plugin loader —
// every file at 0%, and every control SECURITY.md names as a mitigation. Reporting a
// figure that excludes the untested code is worse than reporting none.
export default defineConfig({
    test: {
        include: ['tests/unit/**/*.test.ts'],
        environment: 'node',
        // The ingest and git tests drive a real ts-morph program, the TypeScript
        // checker and real git subprocesses. Under v8 coverage instrumentation a
        // single checker-backed analysis exceeds the 5s default, which surfaced as
        // two tests failing only when coverage was enabled.
        testTimeout: 60_000,
        hookTimeout: 60_000,
        coverage: {
            provider: 'v8',
            include: ['src/**/*.ts'],
            // Type-only and entry modules contain no branches worth measuring; leaving
            // them in depresses the figure without indicating any real risk.
            exclude: ['src/models/**', 'src/index.ts', 'src/mcp-index.ts'],
            reporter: ['text', 'html', 'json-summary'],
        },
    },
});
