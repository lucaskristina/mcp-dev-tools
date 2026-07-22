const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const CURRENT_LEVEL = process.env.LOG_LEVEL || 'info';

function formatMsg(level, module, message, meta = {}) {
    const ts = new Date().toISOString();
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `[${ts}] [${level.toUpperCase()}] [${module}] ${message}${metaStr}`;
}

function createLogger(module) {
    return {
        debug: (msg, meta) => {
            if (LOG_LEVELS[CURRENT_LEVEL] <= 0)
                process.stderr.write(formatMsg('debug', module, msg, meta) + '\n');
        },
        info: (msg, meta) => {
            if (LOG_LEVELS[CURRENT_LEVEL] <= 1)
                process.stderr.write(formatMsg('info', module, msg, meta) + '\n');
        },
        warn: (msg, meta) => {
            if (LOG_LEVELS[CURRENT_LEVEL] <= 2)
                process.stderr.write(formatMsg('warn', module, msg, meta) + '\n');
        },
        error: (msg, meta) => {
            process.stderr.write(formatMsg('error', module, msg, meta) + '\n');
        }
    };
}

export { createLogger };
export default createLogger;
