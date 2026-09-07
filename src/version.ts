import * as fs from 'fs';
import * as path from 'path';

/**
 * Single source of truth for the version Veris reports — CLI, MCP handshake,
 * report metadata. Reads package.json rather than duplicating the literal, so
 * `npm version` is the only place a release number is edited.
 *
 * Resolution walks up from this module: works from src/ under ts-node and from
 * dist/ after a build.
 */
function resolveVersion(): string {
    let dir = __dirname;
    for (let i = 0; i < 4; i++) {
        const candidate = path.join(dir, 'package.json');
        if (fs.existsSync(candidate)) {
            try {
                const pkg = JSON.parse(fs.readFileSync(candidate, 'utf8'));
                if (pkg && typeof pkg.version === 'string' && pkg.name === 'veris-core') {
                    return pkg.version;
                }
            } catch {
                // fall through to the parent directory
            }
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return '0.0.0-unknown';
}

export const VERIS_VERSION = resolveVersion();
