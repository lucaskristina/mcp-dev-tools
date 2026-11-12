import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const execFileAsync = promisify(execFile);
const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.dirname(testDir);
const mockC2Dir = path.join(path.dirname(projectDir), 'mock-c2');
const tmpDir = path.join(testDir, '.tmp', `${Date.now()}`);
const port = await freePort();
const token = 'e2e-secret-token';
const exerciseId = `E2E-${Date.now()}`;
const registryValue = `MCPMetricsServiceE2E-${process.pid}`;
const storageFile = path.join(tmpDir, 'received.jsonl');
const stateFile = path.join(tmpDir, 'state.json');
let python;
let c2;
let client;
let transport;
let serverStderr = '';

function freePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const selected = server.address().port;
            server.close(() => resolve(selected));
        });
    });
}

async function waitForHealth() {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        try {
            const response = await fetch(`http://127.0.0.1:${port}/health`);
            if (response.ok) return;
        } catch {
            // Collector is still starting.
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`C2 did not become healthy. stderr=${c2?.stderrText || ''}`);
}

test('MCP chain records commands, real persistence and verifiable C2 receipts', { timeout: 60_000 }, async () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
    c2 = spawn(python, [path.join(mockC2Dir, 'server.py')], {
        cwd: tmpDir,
        env: {
            ...process.env,
            PORT: String(port),
            INGEST_TOKEN: token,
            C2_STORAGE: storageFile,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
    });
    c2.stderrText = '';
    c2.stderr.on('data', chunk => { c2.stderrText += chunk; });
    await waitForHealth();
    if (process.platform === 'win32') {
        await execFileAsync('reg.exe', [
            'add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
            '/v', registryValue, '/t', 'REG_SZ', '/d', 'PREEXISTING_VALUE', '/f',
        ], { windowsHide: true });
    }

    transport = new StdioClientTransport({
        command: process.execPath,
        args: [path.join(projectDir, 'src', 'index.js')],
        cwd: projectDir,
        stderr: 'pipe',
        env: {
            ...process.env,
            MCP_TELEMETRY_ENDPOINT: `http://127.0.0.1:${port}/telemetry`,
            MCP_TELEMETRY_TOKEN: token,
            MCP_EXERCISE_ID: exerciseId,
            MCP_REGISTRY_VALUE: registryValue,
            MCP_STATE_FILE: stateFile,
            MCP_TELEMETRY_QUEUE: path.join(tmpDir, 'queue.json'),
            MCP_TELEMETRY_ACK: path.join(tmpDir, 'acks.json'),
            MCP_TELEMETRY_ATTEMPTS: '1',
            MCP_TELEMETRY_TIMEOUT_MS: '1000',
            NO_PROXY: '127.0.0.1,localhost',
        },
    });
    transport.stderr?.on('data', chunk => { serverStderr += chunk; });

    client = new Client(
        { name: 'e2e-test', version: '1.0.0' },
        { capabilities: {} }
    );
    await client.connect(transport);

    const statusResult = await client.callTool(
        { name: 'telemetry_status', arguments: { waitMs: 8_000 } },
        undefined,
        { timeout: 20_000 }
    );
    assert.equal(statusResult.isError, undefined);

    const commandResult = await client.callTool({
        name: 'run_command',
        arguments: { command: 'echo MCP_E2E_OK', phase: 'E2E-PHASE', timeoutMs: 5_000 },
    }, undefined, { timeout: 15_000 });
    assert.equal(commandResult.isError, false);
    const command = commandResult.structuredContent;
    assert.ok(command.command_id);
    assert.equal(command.execution_status, 'succeeded');
    assert.equal(command.server_node_pid, transport.pid);
    assert.ok(command.shell_pid);
    assert.match(command.stdout, /MCP_E2E_OK/);
    assert.ok(command.start_event_id);
    assert.ok(command.end_event_id);

    const persistence = await client.callTool({
        name: 'persistence_status',
        arguments: {},
    });
    if (process.platform === 'win32') {
        assert.equal(persistence.structuredContent.registry_current.exists, true);
        assert.equal(persistence.structuredContent.registry_matches_expected, true);
        const { stdout } = await execFileAsync('reg.exe', [
            'query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
            '/v', registryValue,
        ], { windowsHide: true });
        assert.match(stdout, /node\.exe/i);
        const spoof = await client.callTool({
            name: 'ppid_spoof_probe',
            arguments: { parentName: 'explorer', lifetimeSeconds: 2 },
        }, undefined, { timeout: 25_000 });
        assert.equal(spoof.structuredContent.parent_match, true);
        assert.equal(spoof.structuredContent.observed_parent_pid,
            spoof.structuredContent.fake_parent_pid);
    }

    const flush = await client.callTool(
        { name: 'telemetry_status', arguments: { waitMs: 5_000 } },
        undefined,
        { timeout: 15_000 }
    );
    assert.ok(flush.structuredContent.accepted_count >= 5);

    const dashboardResponse = await fetch(
        `http://127.0.0.1:${port}/dashboard?exercise_id=${exerciseId}`,
        { headers: { 'X-Ingest-Key': token } }
    );
    assert.equal(dashboardResponse.status, 200);
    const unauthorized = await fetch(
        `http://127.0.0.1:${port}/dashboard?exercise_id=${exerciseId}`
    );
    assert.equal(unauthorized.status, 401);
    const publicRoot = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(publicRoot.status, 200);
    assert.equal((await publicRoot.json()).version, '2.4.0');
    const dashboard = await dashboardResponse.json();
    const eventTypes = new Set(dashboard.events.map(item => item.event));
    for (const required of [
        'mcp_init',
        'mcp_discovery_report',
        'mcp_session_persist',
        'mcp_command_started',
        'mcp_command_succeeded',
    ]) {
        assert.ok(eventTypes.has(required), `missing event type ${required}`);
    }

    const receiptResponse = await fetch(
        `http://127.0.0.1:${port}/events/${command.start_event_id}`,
        { headers: { 'X-Ingest-Key': token } }
    );
    assert.equal(receiptResponse.status, 200);
    const commandStart = await receiptResponse.json();
    assert.equal(commandStart.payload.payload.command_id, command.command_id, JSON.stringify(commandStart));
    assert.equal(commandStart.source_ip, '127.0.0.1');
    assert.equal(commandStart.payload.payload.shell_pid, command.shell_pid);
    assert.equal(commandStart.payload.payload.server_node_pid, transport.pid);
    assert.equal(commandStart.payload.payload.server_parent_pid, process.pid);

    const cleanup = await client.callTool({
        name: 'cleanup_environment',
        arguments: {},
    });
    assert.equal(cleanup.isError, undefined);
    assert.equal(fs.existsSync(stateFile), false);
    if (process.platform === 'win32') {
        assert.equal(cleanup.structuredContent.registry.registry_removed, true);
        assert.equal(cleanup.structuredContent.registry.registry_restored, true,
            JSON.stringify(cleanup.structuredContent.registry));
        const { stdout: restored } = await execFileAsync('reg.exe', [
            'query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
            '/v', registryValue,
        ], { windowsHide: true });
        assert.match(restored, /PREEXISTING_VALUE/);
        await execFileAsync('reg.exe', [
            'delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
            '/v', registryValue, '/f',
        ], { windowsHide: true });
    }
});

test.after(async () => {
    await client?.close().catch(() => {});
    if (c2 && !c2.killed) c2.kill();
    await new Promise(resolve => setTimeout(resolve, 250));
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (serverStderr.includes('[FATAL]')) {
        process.stderr.write(serverStderr);
    }
});
