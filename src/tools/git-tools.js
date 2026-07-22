import { exec } from 'child_process';
import { promisify } from 'util';
import { z } from 'zod';
import { createLogger } from '../lib/logger.js';
import { toolHandler } from '../lib/utils.js';
import { sanitizeOutput } from '../lib/validator.js';

const log = createLogger('git-tools');
const execAsync = promisify(exec);

async function git(args, cwd) {
    try {
        const { stdout, stderr } = await execAsync(`git ${args}`, {
            cwd: cwd || process.cwd(),
            timeout: 15000
        });
        return stdout || stderr;
    } catch (err) {
        throw new Error(err.stderr || err.message);
    }
}

export function registerGitTools(server) {

    server.tool(
        'git_status',
        'Show the working tree status of a git repository',
        {
            repoPath: z.string().optional().describe('Path to git repo (defaults to cwd)')
        },
        toolHandler('git_status', async ({ repoPath }) => {
            const output = await git('status --short --branch', repoPath);
            return { content: [{ type: 'text', text: sanitizeOutput(output) }] };
        })
    );

    server.tool(
        'git_log',
        'Show commit history',
        {
            repoPath: z.string().optional(),
            maxCount: z.number().int().min(1).max(100).optional().default(20),
            oneline: z.boolean().optional().default(true)
        },
        toolHandler('git_log', async ({ repoPath, maxCount, oneline }) => {
            const fmt = oneline ? '--oneline' : '--format="%h %an %ar%n%s%n"';
            const output = await git(`log ${fmt} -n ${maxCount}`, repoPath);
            return { content: [{ type: 'text', text: sanitizeOutput(output) }] };
        })
    );

    server.tool(
        'git_diff',
        'Show changes between commits, working tree, etc.',
        {
            repoPath: z.string().optional(),
            target: z.string().optional().default('HEAD'),
            staged: z.boolean().optional().default(false)
        },
        toolHandler('git_diff', async ({ repoPath, target, staged }) => {
            const stagedFlag = staged ? '--staged' : '';
            const output = await git(`diff ${stagedFlag} ${target}`, repoPath);
            return { content: [{ type: 'text', text: sanitizeOutput(output) || '(no changes)' }] };
        })
    );

    server.tool(
        'git_branches',
        'List local and remote branches',
        {
            repoPath: z.string().optional(),
            remote: z.boolean().optional().default(false)
        },
        toolHandler('git_branches', async ({ repoPath, remote }) => {
            const flag = remote ? '-a' : '';
            const output = await git(`branch ${flag} -v`, repoPath);
            return { content: [{ type: 'text', text: sanitizeOutput(output) }] };
        })
    );

    log.info('Git tools registered');
}
