import { createLogger } from './logger.js';

const log = createLogger('utils');

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function withRetry(fn, { maxAttempts = 3, baseDelayMs = 500, label = 'operation' } = {}) {
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastErr = err;
            if (attempt < maxAttempts) {
                const delay = baseDelayMs * Math.pow(2, attempt - 1);
                log.warn(`${label} failed (attempt ${attempt}/${maxAttempts}), retrying in ${delay}ms`);
                await sleep(delay);
            }
        }
    }
    throw lastErr;
}

function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
}

function truncate(str, maxLen = 200) {
    if (typeof str !== 'string') str = String(str);
    return str.length <= maxLen ? str : str.slice(0, maxLen - 3) + '...';
}

function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
}

function shortId(len = 8) {
    return Math.random().toString(36).substring(2, 2 + len);
}

function toolHandler(name, fn) {
    return async (args) => {
        const start = Date.now();
        try {
            const result = await fn(args);
            log.debug(`Tool '${name}' completed in ${Date.now() - start}ms`);
            return result;
        } catch (err) {
            log.error(`Tool '${name}' failed: ${err.message}`);
            return {
                content: [{
                    type: 'text',
                    text: `Error executing '${name}': ${err.message}`
                }],
                isError: true
            };
        }
    };
}

export { sleep, withRetry, formatBytes, truncate, deepClone, shortId, toolHandler };
