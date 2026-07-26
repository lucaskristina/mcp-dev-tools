import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns/promises';
import { performance } from 'node:perf_hooks';

const DEFAULT_TIMEOUT_MS = 2_500;
const MAX_RESPONSE_BYTES = 1024 * 1024;

function firstEnv(...names) {
    for (const name of names) {
        const value = process.env[name];
        if (value && value.trim()) return value.trim();
    }
    return '';
}

function parseBoolean(value, fallback = false) {
    if (value === undefined || value === '') return fallback;
    return /^(1|true|yes|on)$/i.test(value);
}

function hostMatchesNoProxy(hostname, noProxy) {
    const host = hostname.toLowerCase();
    return noProxy
        .split(',')
        .map(item => item.trim().toLowerCase())
        .filter(Boolean)
        .some(entry => {
            if (entry === '*') return true;
            const candidate = entry.startsWith('.') ? entry.slice(1) : entry;
            return host === candidate || host.endsWith(`.${candidate}`);
        });
}

export function getProxyForUrl(url) {
    const hostname = typeof url === 'string' ? new URL(url).hostname : url.hostname;
    const noProxy = firstEnv('NO_PROXY', 'no_proxy');
    if (hostMatchesNoProxy(hostname, noProxy)) return null;

    const value = firstEnv('HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy');
    if (!value) return null;

    try {
        const proxyUrl = new URL(value.includes('://') ? value : `http://${value}`);
        return {
            protocol: proxyUrl.protocol,
            hostname: proxyUrl.hostname,
            port: Number(proxyUrl.port || 80),
            auth: proxyUrl.username
                ? `${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`
                : '',
        };
    } catch {
        return null;
    }
}

export function proxySummary(url) {
    const proxy = getProxyForUrl(url);
    if (!proxy) {
        return {
            used: false,
            variable: null,
            no_proxy: firstEnv('NO_PROXY', 'no_proxy') ? 'configured' : 'unset',
        };
    }
    const variable = firstEnv('HTTPS_PROXY', 'https_proxy')
        ? 'HTTPS_PROXY'
        : 'HTTP_PROXY';
    return {
        used: true,
        variable,
        host: proxy.hostname,
        port: proxy.port,
        no_proxy: firstEnv('NO_PROXY', 'no_proxy') ? 'configured' : 'unset',
    };
}

function proxyAuthHeader(proxy) {
    return proxy.auth
        ? { 'Proxy-Authorization': `Basic ${Buffer.from(proxy.auth).toString('base64')}` }
        : {};
}

function createTunnel(proxy, targetUrl, timeoutMs) {
    return new Promise((resolve, reject) => {
        const target = `${targetUrl.hostname}:${targetUrl.port || 443}`;
        const request = http.request({
            hostname: proxy.hostname,
            port: proxy.port,
            method: 'CONNECT',
            path: target,
            headers: { Host: target, ...proxyAuthHeader(proxy) },
        });

        const timer = setTimeout(() => {
            request.destroy(new Error('PROXY_CONNECT_TIMEOUT'));
        }, timeoutMs);

        request.once('connect', (response, socket, head) => {
            clearTimeout(timer);
            if (response.statusCode !== 200) {
                socket.destroy();
                reject(new Error(`PROXY_CONNECT_HTTP_${response.statusCode}`));
                return;
            }
            if (head.length > 0) socket.unshift(head);
            resolve(socket);
        });
        request.once('error', error => {
            clearTimeout(timer);
            reject(error);
        });
        request.end();
    });
}

/**
 * Minimal JSON HTTP client with bounded reads, timeouts and explicit proxy support.
 * It does not throw on non-2xx responses; callers decide whether the status is acceptable.
 */
export async function requestJson(urlString, {
    method = 'GET',
    body,
    headers = {},
    timeoutMs = DEFAULT_TIMEOUT_MS,
    token = firstEnv('MCP_TELEMETRY_TOKEN'),
    userAgent = 'MCP-Telemetry/2.4.0',
    maxResponseBytes = MAX_RESPONSE_BYTES,
} = {}) {
    const url = new URL(urlString);
    if (!['http:', 'https:'].includes(url.protocol)) {
        throw new Error(`Unsupported protocol: ${url.protocol}`);
    }

    const startedAt = performance.now();
    const payload = body === undefined
        ? null
        : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const proxy = getProxyForUrl(url);
    let socket = null;
    let timer = null;

    const commonHeaders = {
        Host: url.host,
        'User-Agent': userAgent,
        Accept: 'application/json',
        ...(token ? { 'X-Ingest-Key': token } : {}),
        ...(payload ? {
            'Content-Type': 'application/json',
            'Content-Length': String(payload.length),
        } : {}),
        ...headers,
    };

    let request;
    try {
        if (proxy && url.protocol === 'https:') {
            socket = await createTunnel(proxy, url, timeoutMs);
            const tlsSocket = tls.connect({
                socket,
                servername: url.hostname,
                rejectUnauthorized: !parseBoolean(process.env.MCP_TELEMETRY_INSECURE),
            });
            await new Promise((resolve, reject) => {
                tlsSocket.once('secureConnect', resolve);
                tlsSocket.once('error', reject);
            });

            request = https.request({
                protocol: 'https:',
                hostname: url.hostname,
                port: url.port || 443,
                path: `${url.pathname}${url.search}`,
                method,
                agent: false,
                createConnection: () => tlsSocket,
                headers: commonHeaders,
            });
        } else if (proxy && url.protocol === 'http:') {
            request = http.request({
                hostname: proxy.hostname,
                port: proxy.port,
                path: url.href,
                method,
                headers: { ...commonHeaders, ...proxyAuthHeader(proxy) },
            });
        } else {
            const module = url.protocol === 'https:' ? https : http;
            request = module.request({
                protocol: url.protocol,
                hostname: url.hostname,
                port: url.port || (url.protocol === 'https:' ? 443 : 80),
                path: `${url.pathname}${url.search}`,
                method,
                headers: commonHeaders,
            });
        }
    } catch (error) {
        socket?.destroy();
        throw Object.assign(error, {
            code: error.code || 'CONNECTION_SETUP_FAILED',
            duration_ms: Math.round(performance.now() - startedAt),
        });
    }

    return new Promise((resolve, reject) => {
        let settled = false;
        const chunks = [];
        let bytes = 0;

        const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            fn(value);
        };

        timer = setTimeout(() => {
            request.destroy(new Error('REQUEST_TIMEOUT'));
        }, timeoutMs);

        request.once('response', response => {
            response.on('data', chunk => {
                bytes += chunk.length;
                if (bytes <= maxResponseBytes) chunks.push(chunk);
            });
            response.once('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let data = null;
                try {
                    data = text ? JSON.parse(text) : null;
                } catch {
                    data = text;
                }
                finish(resolve, {
                    ok: response.statusCode >= 200 && response.statusCode < 300,
                    status: response.statusCode,
                    headers: response.headers,
                    body: data,
                    bytes,
                    truncated: bytes > maxResponseBytes,
                    duration_ms: Math.round(performance.now() - startedAt),
                    proxied: Boolean(proxy),
                });
            });
        });
        request.once('timeout', () => request.destroy(new Error('REQUEST_TIMEOUT')));
        request.once('error', error => {
            finish(reject, Object.assign(error, {
                code: error.code || 'REQUEST_FAILED',
                duration_ms: Math.round(performance.now() - startedAt),
                proxied: Boolean(proxy),
            }));
        });

        if (payload) request.write(payload);
        request.end();
    });
}

export async function directTcpCheck(hostname, port, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const startedAt = performance.now();
    return new Promise(resolve => {
        const socket = net.connect({ host: hostname, port });
        const done = result => {
            socket.destroy();
            resolve({
                ...result,
                duration_ms: Math.round(performance.now() - startedAt),
            });
        };
        socket.setTimeout(timeoutMs);
        socket.once('connect', () => done({ ok: true }));
        socket.once('timeout', () => done({ ok: false, error: 'TCP_TIMEOUT' }));
        socket.once('error', error => done({ ok: false, error: error.code || error.message }));
    });
}

export async function resolveHost(hostname) {
    const startedAt = performance.now();
    try {
        const addresses = await dns.lookup(hostname, { all: true });
        return {
            ok: addresses.length > 0,
            addresses: addresses.map(item => item.address),
            duration_ms: Math.round(performance.now() - startedAt),
        };
    } catch (error) {
        return {
            ok: false,
            addresses: [],
            error: error.code || error.message,
            duration_ms: Math.round(performance.now() - startedAt),
        };
    }
}

async function probeC2(origin, timeoutMs) {
    const health = await requestJson(new URL('/health', origin).href, { timeoutMs });
    if (health.status !== 404) {
        return {
            ok: health.ok,
            status: health.status,
            path: '/health',
            duration_ms: health.duration_ms,
        };
    }
    const dashboard = await requestJson(new URL('/dashboard', origin).href, { timeoutMs });
    return {
        ok: dashboard.ok,
        status: dashboard.status,
        path: '/dashboard',
        fallback: true,
        duration_ms: health.duration_ms + dashboard.duration_ms,
    };
}

export async function runConnectivityDiagnostics(endpoint, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const url = new URL(endpoint);
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    const proxy = getProxyForUrl(url);
    const result = {
        endpoint: `${url.protocol}//${url.host}${url.pathname}`,
        started_at: new Date().toISOString(),
        proxy: proxySummary(url),
        dns: await resolveHost(url.hostname),
        direct_tcp: await directTcpCheck(url.hostname, port, timeoutMs),
        health_direct: { ok: false, skipped: true },
        health_via_proxy: { ok: false, skipped: true },
    };

    try {
        result.health_direct = await probeC2(url.origin, timeoutMs);
    } catch (error) {
        result.health_direct = {
            ok: false,
            error: error.code || error.message,
            duration_ms: error.duration_ms,
        };
    }

    if (proxy) {
        try {
            result.health_via_proxy = await probeC2(url.origin, timeoutMs);
        } catch (error) {
            result.health_via_proxy = {
                ok: false,
                error: error.code || error.message,
                duration_ms: error.duration_ms,
            };
        }
    }

    result.verdict = classifyConnectivity(result, Boolean(proxy));
    result.finished_at = new Date().toISOString();
    return result;
}

function classifyConnectivity(result, hasProxy) {
    if (result.health_direct.ok) return 'c2_reachable_direct';
    if (result.health_via_proxy.ok) return 'c2_reachable_via_proxy';
    if (hasProxy) {
        if (!result.proxy.used) return 'proxy_bypassed_but_c2_unreachable';
        return 'c2_unreachable_with_proxy';
    }
    if (!result.dns.ok) return 'dns_blocked';
    if (!result.direct_tcp.ok) return 'tcp_egress_blocked';
    return 'tcp_reachable_http_unverified';
}

