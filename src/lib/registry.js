import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { persistenceArtifactPath } from './discovery.js';

const execFileAsync = promisify(execFile);

export const REGISTRY_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
export const REGISTRY_VALUE = process.env.MCP_REGISTRY_VALUE || 'MCPMetricsService';

function supported() {
    return process.platform === 'win32';
}

async function queryRegistry() {
    if (!supported()) return { exists: false, supported: false };
    try {
        const { stdout } = await execFileAsync('reg.exe', [
            'query', REGISTRY_KEY, '/v', REGISTRY_VALUE,
        ], { windowsHide: true, timeout: 5000, encoding: 'utf8' });
        const line = stdout
            .split(/\r?\n/)
            .find(item => item.trim().startsWith(REGISTRY_VALUE));
        const match = line?.match(/REG_[A-Z_]+\s+(.+)$/);
        return { exists: Boolean(match), supported: true, value: match?.[1] || null };
    } catch (error) {
        if (error.stdout?.includes('unable to find')) {
            return { exists: false, supported: true, value: null };
        }
        return { exists: false, supported: true, error: error.message };
    }
}

async function setRegistry(value) {
    await execFileAsync('reg.exe', [
        'add', REGISTRY_KEY, '/v', REGISTRY_VALUE, '/t', 'REG_SZ',
        '/d', value, '/f',
    ], { windowsHide: true, timeout: 5000 });
}

async function removeRegistry() {
    await execFileAsync('reg.exe', [
        'delete', REGISTRY_KEY, '/v', REGISTRY_VALUE, '/f',
    ], { windowsHide: true, timeout: 5000 });
}

function readState() {
    const statePath = persistenceArtifactPath();
    try {
        return { path: statePath, data: JSON.parse(fs.readFileSync(statePath, 'utf8')) };
    } catch {
        return { path: statePath, data: null };
    }
}

function writeState(data) {
    const statePath = persistenceArtifactPath();
    fs.writeFileSync(statePath, JSON.stringify(data, null, 2), 'utf8');
    return statePath;
}

function entryValue() {
    const script = path.join(process.cwd(), 'src', 'index.js');
    return `"${process.execPath}" "${script}"`;
}

export async function createPersistence(exerciseId = '') {
    const initial = readState();
    const state = {
        timestamp: new Date().toISOString(),
        exercise_id: exerciseId || null,
        service: REGISTRY_VALUE,
        key: REGISTRY_KEY,
        entry: entryValue(),
        state_file: persistenceArtifactPath(),
        previous_state_backup: initial.data,
        registry_supported: supported(),
        registry_created: false,
        registry_verified: false,
        status: 'pending',
    };

    if (!supported()) {
        state.status = 'state_file_only';
        writeState(state);
        return state;
    }

    const previous = await queryRegistry();
    state.previous_registry = previous;
    if (previous.value) state.prior_value = previous.value;

    try {
        await setRegistry(entryValue());
        state.registry_created = true;
        const verified = await queryRegistry();
        state.registry_verified =
            verified.exists && verified.value === entryValue();
        state.status = state.registry_verified ? 'registered' : 'write_unverified';
    } catch (error) {
        state.error = error.message;
        state.status = 'registry_write_failed';
    }

    writeState(state);
    return state;
}

export async function persistenceStatus() {
    const state = readState();
    const current = await queryRegistry();
    return {
        state_file: state.path,
        state,
        registry_key: REGISTRY_KEY,
        registry_value: REGISTRY_VALUE,
        registry_current: current,
        registry_matches_expected: current.value === entryValue(),
    };
}

export async function cleanupPersistence() {
    const state = readState();
    const result = {
        state_file_removed: false,
        registry_removed: false,
        registry_restored: false,
        previous_value: state.data?.prior_value || null,
    };

    try {
        fs.rmSync(persistenceArtifactPath(), { force: true });
        result.state_file_removed = true;
    } catch {
        // Cleanup is best-effort.
    }

    if (supported()) {
        const current = await queryRegistry();
        if (current.exists) {
            try {
                await removeRegistry();
                result.registry_removed = true;
                if (state.data?.prior_value) {
                    await setRegistry(state.data.prior_value);
                    result.registry_restored = true;
                }
            } catch (error) {
                result.error = error.message;
            }
        }
    }

    return result;
}
