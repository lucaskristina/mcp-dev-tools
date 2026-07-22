import fs from 'fs/promises';
import path from 'path';
import { z } from 'zod';
import { createLogger } from '../lib/logger.js';
import { validateFilePath, sanitizeOutput } from '../lib/validator.js';
import { responseCache } from '../lib/cache.js';
import { formatBytes, toolHandler } from '../lib/utils.js';

const log = createLogger('file-tools');

export function registerFileTools(server) {

    server.tool(
        'read_file',
        'Read the full content of a file',
        {
            path: z.string().describe('Absolute or relative file path'),
            encoding: z.enum(['utf-8', 'base64']).optional().default('utf-8')
        },
        toolHandler('read_file', async ({ path: filePath, encoding }) => {
            const { valid, reason, normalized } = validateFilePath(filePath);
            if (!valid) return { content: [{ type: 'text', text: `Validation error: ${reason}` }], isError: true };

            const cacheKey = `read:${normalized}`;
            const cached = responseCache.get(cacheKey);
            if (cached) return cached;

            const content = await fs.readFile(normalized, encoding);
            const result = { content: [{ type: 'text', text: sanitizeOutput(content) }] };
            responseCache.set(cacheKey, result);
            log.info('read_file', { path: normalized, size: formatBytes(Buffer.byteLength(content)) });
            return result;
        })
    );

    server.tool(
        'write_file',
        'Write or overwrite a file with given content',
        {
            path: z.string().describe('File path to write'),
            content: z.string().describe('Content to write'),
            createDirs: z.boolean().optional().default(false)
        },
        toolHandler('write_file', async ({ path: filePath, content, createDirs }) => {
            const { valid, reason, normalized } = validateFilePath(filePath);
            if (!valid) return { content: [{ type: 'text', text: `Validation error: ${reason}` }], isError: true };

            if (createDirs) await fs.mkdir(path.dirname(normalized), { recursive: true });
            await fs.writeFile(normalized, content, 'utf-8');
            responseCache.invalidate(`read:${normalized}`);
            log.info('write_file', { path: normalized, bytes: Buffer.byteLength(content) });
            return { content: [{ type: 'text', text: `Written ${formatBytes(Buffer.byteLength(content))} to ${normalized}` }] };
        })
    );

    server.tool(
        'list_directory',
        'List contents of a directory',
        {
            path: z.string().describe('Directory path'),
            recursive: z.boolean().optional().default(false),
            showHidden: z.boolean().optional().default(false)
        },
        toolHandler('list_directory', async ({ path: dirPath, recursive, showHidden }) => {
            const { valid, reason, normalized } = validateFilePath(dirPath);
            if (!valid) return { content: [{ type: 'text', text: `Validation error: ${reason}` }], isError: true };

            async function listDir(dir, depth = 0) {
                const entries = await fs.readdir(dir, { withFileTypes: true });
                const lines = [];
                for (const entry of entries) {
                    if (!showHidden && entry.name.startsWith('.')) continue;
                    const indent = '  '.repeat(depth);
                    const icon = entry.isDirectory() ? '📁' : '📄';
                    lines.push(`${indent}${icon} ${entry.name}`);
                    if (recursive && entry.isDirectory()) {
                        lines.push(...await listDir(path.join(dir, entry.name), depth + 1));
                    }
                }
                return lines;
            }

            const lines = await listDir(normalized);
            return { content: [{ type: 'text', text: lines.join('\n') || '(empty directory)' }] };
        })
    );

    server.tool(
        'file_info',
        'Get metadata about a file or directory',
        { path: z.string().describe('File or directory path') },
        toolHandler('file_info', async ({ path: filePath }) => {
            const { valid, reason, normalized } = validateFilePath(filePath.replace(/[/\\]+$/, ''));
            if (!valid) return { content: [{ type: 'text', text: `Validation error: ${reason}` }], isError: true };

            const stat = await fs.stat(normalized);
            const info = {
                path: normalized,
                type: stat.isDirectory() ? 'directory' : 'file',
                size: formatBytes(stat.size),
                created: stat.birthtime.toISOString(),
                modified: stat.mtime.toISOString(),
                permissions: stat.mode.toString(8).slice(-3),
            };
            return { content: [{ type: 'text', text: JSON.stringify(info, null, 2) }] };
        })
    );

    log.info('File tools registered');
}
