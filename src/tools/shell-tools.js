import { exec } from 'child_process';
import { promisify } from 'util';
import { z } from 'zod';
import { createLogger } from '../lib/logger.js';
import { validateCommand, sanitizeOutput } from '../lib/validator.js';
import { toolHandler } from '../lib/utils.js';

const log = createLogger('shell-tools');
const execAsync = promisify(exec);

export function registerShellTools(server) {

    server.tool(
        'run_command',
        'Execute a shell command and return stdout/stderr',
        {
            command: z.string().describe('Shell command to execute'),
            cwd: z.string().optional().describe('Working directory'),
            timeoutMs: z.number().int().min(100).max(30000).optional().default(10000),
            env: z.record(z.string()).optional().describe('Additional environment variables')
        },
        toolHandler('run_command', async ({ command, cwd, timeoutMs, env }) => {
            const { valid, reason } = validateCommand(command);
            if (!valid) return { content: [{ type: 'text', text: `Blocked: ${reason}` }], isError: true };

            log.info('run_command', { command: command.slice(0, 80), cwd });

            const { stdout, stderr } = await execAsync(command, {
                cwd: cwd || process.cwd(),
                timeout: timeoutMs,
                env: { ...process.env, ...(env || {}) },
                maxBuffer: 1024 * 1024 * 10
            });

            const output = [
                stdout && `STDOUT:\n${sanitizeOutput(stdout)}`,
                stderr && `STDERR:\n${sanitizeOutput(stderr)}`
            ].filter(Boolean).join('\n\n') || '(no output)';

            return { content: [{ type: 'text', text: output }] };
        })
    );

    server.tool(
        'get_environment',
        'Get current environment variables (filtered for safety)',
        {
            filter: z.string().optional().describe('Optional prefix filter, e.g. "NODE"')
        },
        toolHandler('get_environment', async ({ filter }) => {
            const BLOCKED_KEYS = /token|secret|password|key|credential|auth|apikey/i;
            const entries = Object.entries(process.env)
                .filter(([k]) => !BLOCKED_KEYS.test(k))
                .filter(([k]) => !filter || k.toUpperCase().startsWith(filter.toUpperCase()))
                .sort(([a], [b]) => a.localeCompare(b));

            const text = entries.map(([k, v]) => `${k}=${v}`).join('\n');
            return { content: [{ type: 'text', text: text || '(no matching variables)' }] };
        })
    );

    server.tool(
        'process_list',
        'List currently running processes',
        {},
        toolHandler('process_list', async () => {
            const cmd = process.platform === 'win32'
                ? 'tasklist /FO CSV /NH'
                : 'ps aux --no-headers';
            const { stdout } = await execAsync(cmd, { timeout: 8000 });
            return { content: [{ type: 'text', text: sanitizeOutput(stdout) }] };
        })
    );

    log.info('Shell tools registered');
}
