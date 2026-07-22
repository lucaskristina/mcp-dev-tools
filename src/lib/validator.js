import path from 'path';
import { createLogger } from './logger.js';

const log = createLogger('validator');

const BLOCKED_SHELL_PATTERNS = [
    /rm\s+-rf\s+[\/~]/i,
    /del\s+\/[fqs]/i,
    /format\s+[a-z]:/i,
    /mkfs/i,
    /dd\s+if=/i,
    />\s*\/dev\/sd/i,
    /shutdown/i,
    /reboot/i,
];

const SAFE_EXTENSIONS = new Set([
    '.js', '.ts', '.jsx', '.tsx', '.json', '.yaml', '.yml',
    '.md', '.txt', '.env', '.sh', '.py', '.go', '.rs', '.java',
    '.html', '.css', '.sql', '.toml', '.ini', '.cfg', '.conf',
    '.xml', '.csv', '.log',
]);

function validateFilePath(inputPath, { allowedBasePaths = [] } = {}) {
    if (!inputPath || typeof inputPath !== 'string') {
        return { valid: false, reason: 'Path must be a non-empty string' };
    }

    const normalized = path.resolve(inputPath);
    const ext = path.extname(normalized).toLowerCase();

    if (ext && !SAFE_EXTENSIONS.has(ext)) {
        log.warn(`Blocked unsafe extension: ${ext}`, { path: normalized });
        return { valid: false, reason: `Extension '${ext}' is not permitted` };
    }

    if (allowedBasePaths.length > 0) {
        const allowed = allowedBasePaths.some(base =>
            normalized.startsWith(path.resolve(base))
        );
        if (!allowed) {
            log.warn('Path outside allowed base paths', { path: normalized });
            return { valid: false, reason: 'Path is outside allowed directories' };
        }
    }

    return { valid: true, normalized };
}

function validateCommand(command) {
    if (!command || typeof command !== 'string') {
        return { valid: false, reason: 'Command must be a non-empty string' };
    }
    if (command.length > 2048) {
        return { valid: false, reason: 'Command exceeds maximum length' };
    }
    for (const pattern of BLOCKED_SHELL_PATTERNS) {
        if (pattern.test(command)) {
            log.warn('Blocked dangerous command pattern', { command });
            return { valid: false, reason: 'Command matches blocked pattern' };
        }
    }
    return { valid: true };
}

function sanitizeOutput(str, maxLen = 50_000) {
    if (typeof str !== 'string') str = String(str);
    return str.length > maxLen ? str.slice(0, maxLen) + '\n... (truncated)' : str;
}

export { validateFilePath, validateCommand, sanitizeOutput };
