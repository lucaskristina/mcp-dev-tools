import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { exec } from 'node:child_process';
import { z } from 'zod';
import { createLogger } from '../lib/logger.js';
import { validateCommand, sanitizeOutput } from '../lib/validator.js';
import { toolHandler } from '../lib/utils.js';
import { newCommandId, recordCommandEvent } from '../lib/metrics.js';

const log = createLogger('shell-tools');
const execAsync = promisify(exec);
const MAX_CAPTURE_BYTES = 10 * 1024 * 1024;
const MAX_RETURN_CHARS = 50_000;

function appendBounded(buffer, chunk) {
    if (buffer.total >= MAX_CAPTURE_BYTES) {
        buffer.truncated = true;
        return;
    }
    const remaining = MAX_CAPTURE_BYTES - buffer.total;
    const part = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
    buffer.chunks.push(part);
    buffer.total += part.length;
    if (part.length < chunk.length) buffer.truncated = true;
}

function outputOf(buffer) {
    return sanitizeOutput(Buffer.concat(buffer.chunks).toString('utf8'), MAX_RETURN_CHARS);
}

function killProcessTree(pid) {
    if (!pid) return;
    if (process.platform === 'win32') {
        spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
        });
    } else {
        try {
            process.kill(pid, 'SIGKILL');
        } catch {
            // Best effort.
        }
    }
}

async function executeCommand(command, { cwd, timeoutMs, phase, env }) {
    const commandId = newCommandId();
    const startedAt = new Date();
    const stdout = { chunks: [], total: 0, truncated: false };
    const stderr = { chunks: [], total: 0, truncated: false };
    let child = null;
    let spawnError = null;
    let timedOut = false;
    let startEventId = null;

    return new Promise(resolve => {
        let settled = false;
        let timer = null;

        const finish = (code, signal) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);

            const finishedAt = new Date();
            const executionStatus = spawnError
                ? 'spawn_failed'
                : timedOut
                    ? 'timeout'
                    : code === 0
                        ? 'succeeded'
                        : 'failed';

            const details = {
                command,
                cwd: cwd || process.cwd(),
                requested_timeout_ms: timeoutMs,
                timeout_fired: timedOut,
                shell_pid: child?.pid || null,
                server_node_pid: process.pid,
                server_parent_pid: process.ppid,
                exit_code: code,
                signal: signal || null,
                duration_ms: finishedAt.getTime() - startedAt.getTime(),
                stdout_bytes: stdout.total,
                stderr_bytes: stderr.total,
                stdout_truncated: stdout.truncated,
                stderr_truncated: stderr.truncated,
                spawn_error: spawnError?.message || null,
            };

            const endEventId = recordCommandEvent(phase, commandId, executionStatus, details);
            resolve({
                commandId,
                startedAt,
                finishedAt,
                executionStatus,
                code,
                signal: signal || null,
                durationMs: finishedAt.getTime() - startedAt.getTime(),
                stdout: outputOf(stdout),
                stderr: outputOf(stderr),
                stdoutBytes: stdout.total,
                stderrBytes: stderr.total,
                stdoutTruncated: stdout.truncated,
                stderrTruncated: stderr.truncated,
                spawnError: spawnError?.message || null,
                timedOut,
                shellPid: child?.pid || null,
                startEventId,
                endEventId,
            });
        };

        try {
            const shell = process.platform === 'win32'
                ? (process.env.ComSpec || 'cmd.exe')
                : '/bin/sh';
            child = spawn(command, {
                cwd: cwd || process.cwd(),
                env: { ...process.env, ...(env || {}) },
                shell,
                windowsHide: true,
            });
        } catch (error) {
            spawnError = error;
            finish(null, null);
            return;
        }

        startEventId = recordCommandEvent(phase, commandId, 'started', {
            command,
            cwd: cwd || process.cwd(),
            requested_timeout_ms: timeoutMs,
            shell_pid: child.pid,
            server_node_pid: process.pid,
            server_parent_pid: process.ppid,
        });

        child.stdout?.on('data', chunk => appendBounded(stdout, chunk));
        child.stderr?.on('data', chunk => appendBounded(stderr, chunk));
        child.once('error', error => {
            spawnError = error;
            finish(null, null);
        });
        child.once('close', (code, signal) => finish(code, signal));
        timer = setTimeout(() => {
            timedOut = true;
            killProcessTree(child?.pid);
        }, timeoutMs);
    });
}

export function registerShellTools(server) {
    server.tool(
        'run_command',
        'Execute a shell command through node -> cmd.exe and return stdout/stderr plus execution and telemetry identifiers',
        {
            command: z.string().describe('Shell command to execute'),
            cwd: z.string().optional().describe('Working directory'),
            timeoutMs: z.number().int().min(100).max(120000).optional().default(10000),
            env: z.record(z.string()).optional().describe('Additional environment variables'),
            phase: z.string().max(80).optional().describe('Exercise phase identifier'),
        },
        toolHandler('run_command', async ({ command, cwd, timeoutMs, env, phase }) => {
            const { valid, reason } = validateCommand(command);
            if (!valid) {
                return {
                    content: [{ type: 'text', text: `Blocked: ${reason}` }],
                    isError: true,
                };
            }

            log.info('run_command', { command: command.slice(0, 120), cwd });
            const selectedPhase = phase || phaseFromEnvironment();
            const result = await executeCommand(command, {
                cwd,
                timeoutMs,
                phase: selectedPhase,
                env,
            });

            const text = [
                `COMMAND: ${command}`,
                `COMMAND_ID: ${result.commandId}`,
                `EXECUTION: ${result.executionStatus} (exit=${result.code}, signal=${result.signal}, timeout=${result.timedOut})`,
                `PID: ${result.shellPid} | SERVER_PID: ${process.pid} | DURATION_MS: ${result.durationMs}`,
                `TELEMETRY: start=${result.startEventId} end=${result.endEventId}`,
                result.stdout && `STDOUT:\n${result.stdout}`,
                result.stderr && `STDERR:\n${result.stderr}`,
            ].filter(Boolean).join('\n');

            return {
                content: [{ type: 'text', text }],
                structuredContent: {
                    command_id: result.commandId,
                    command,
                    cwd: cwd || process.cwd(),
                    phase: selectedPhase,
                    execution_status: result.executionStatus,
                    exit_code: result.code,
                    signal: result.signal,
                    duration_ms: result.durationMs,
                    timed_out: result.timedOut,
                    shell_pid: result.shellPid,
                    server_node_pid: process.pid,
                    server_parent_pid: process.ppid,
                    started_at: result.startedAt.toISOString(),
                    finished_at: result.finishedAt.toISOString(),
                    stdout_bytes: result.stdoutBytes,
                    stderr_bytes: result.stderrBytes,
                    stdout_truncated: result.stdoutTruncated,
                    stderr_truncated: result.stderrTruncated,
                    stdout: result.stdout,
                    stderr: result.stderr,
                    start_event_id: result.startEventId,
                    end_event_id: result.endEventId,
                },
                isError: result.executionStatus === 'spawn_failed',
            };
        })
    );

    server.tool(
        'get_environment',
        'Get current environment variables (filtered for safety)',
        {
            filter: z.string().optional().describe('Optional prefix filter, e.g. "NODE"'),
        },
        toolHandler('get_environment', async ({ filter }) => {
            const BLOCKED_KEYS = /token|secret|password|key|credential|auth|apikey/i;
            const entries = Object.entries(process.env)
                .filter(([key]) => !BLOCKED_KEYS.test(key))
                .filter(([key]) => !filter || key.toUpperCase().startsWith(filter.toUpperCase()))
                .sort(([a], [b]) => a.localeCompare(b));

            const text = entries.map(([key, value]) => `${key}=${value}`).join('\n');
            return {
                content: [{ type: 'text', text: text || '(no matching variables)' }],
                structuredContent: {
                    variables: Object.fromEntries(entries),
                    filter: filter || null,
                },
            };
        })
    );

    server.tool(
        'process_list',
        'List currently running processes',
        {},
        toolHandler('process_list', async () => {
            const command = process.platform === 'win32'
                ? 'tasklist /FO CSV /NH'
                : 'ps aux --no-headers';
            const { stdout } = await execAsync(command, { timeout: 8000 });
            return {
                content: [{ type: 'text', text: sanitizeOutput(stdout) }],
                structuredContent: { command, output: sanitizeOutput(stdout, 20_000) },
            };
        })
    );

    log.info('Shell tools registered');
}

function phaseFromEnvironment() {
    return process.env.MCP_EXERCISE_PHASE || 'unscoped';
}
