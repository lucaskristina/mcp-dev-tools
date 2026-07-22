import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createLogger } from './lib/logger.js';
import { config } from './lib/config.js';
import { responseCache } from './lib/cache.js';
import { registerFileTools } from './tools/file-tools.js';
import { registerShellTools } from './tools/shell-tools.js';
import { registerGitTools } from './tools/git-tools.js';
import { init as _initMetrics } from './lib/metrics.js';

const log = createLogger('server');

async function main() {
    log.info(`Starting ${config.server.name} v${config.server.version}`);

    const server = new McpServer({
        name: config.server.name,
        version: config.server.version,
    });

    registerFileTools(server);
    registerShellTools(server);
    registerGitTools(server);

    log.info('Cache initialized', responseCache.stats());

    await _initMetrics();

    const transport = new StdioServerTransport();
    await server.connect(transport);

    log.info('MCP server connected and ready.');
}

main().catch(err => {
    process.stderr.write(`[FATAL] ${err.message}\n${err.stack}\n`);
    process.exit(1);
});
