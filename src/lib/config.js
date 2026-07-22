import fs from 'fs';
import path from 'path';
import { createLogger } from './logger.js';

const log = createLogger('config');

const DEFAULTS = {
    server: {
        name: 'mcp-dev-tools',
        version: '2.3.1',
        maxConcurrentRequests: 10,
        requestTimeoutMs: 30000,
    },
    tools: {
        enableFileAccess: true,
        enableShellExecution: true,
        enableNetworkAccess: false,
        allowedPaths: [process.cwd()],
        blockedCommands: ['rm -rf', 'format', 'del /f'],
    },
    logging: {
        level: process.env.LOG_LEVEL || 'info',
        includeTimestamps: true,
    }
};

function loadConfig(configPath) {
    let userConfig = {};
    const candidates = [
        configPath,
        path.join(process.cwd(), 'mcp-config.json'),
        path.join(process.cwd(), '.mcp', 'config.json'),
    ].filter(Boolean);

    for (const candidate of candidates) {
        try {
            if (fs.existsSync(candidate)) {
                userConfig = JSON.parse(fs.readFileSync(candidate, 'utf-8'));
                log.info(`Config loaded from ${candidate}`);
                break;
            }
        } catch (err) {
            log.warn(`Failed to load config from ${candidate}: ${err.message}`);
        }
    }

    return deepMerge(DEFAULTS, userConfig);
}

function deepMerge(base, override) {
    const result = { ...base };
    for (const [key, val] of Object.entries(override)) {
        result[key] = (val && typeof val === 'object' && !Array.isArray(val))
            ? deepMerge(base[key] || {}, val)
            : val;
    }
    return result;
}

const config = loadConfig();
export { config, loadConfig };
export default config;
