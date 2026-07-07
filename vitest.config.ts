import { defineConfig } from 'vitest/config';

// Unit tests exercise the pure engines directly against src/ (TypeScript),
// so a change is caught before it ever reaches dist/. The MCP smoke scripts
// under tests/*.ts stay separate — they are integration checks driven by
// `npm run test:mcp:deep`, not vitest, so they are excluded here.
export default defineConfig({
    test: {
        include: ['tests/unit/**/*.test.ts'],
        environment: 'node',
        coverage: {
            provider: 'v8',
            include: ['src/engine/**/*.ts'],
            reporter: ['text', 'html'],
        },
    },
});
