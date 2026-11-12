# Contributing to mcp-dev-tools

Thanks for your interest in contributing! Here's how to get started.

## Development Setup

```bash
git clone https://github.com/lucaskristina/mcp-dev-tools.git
cd mcp-dev-tools
npm install
```

## Project Structure

```text
src/
├── index.js            # Server entry point
├── runner.js           # Automated MCP test and runner client
├── lib/                # HTTP, metrics, registry and utilities
└── tools/              # MCP tool definitions
scripts/                # Native PPID helper
test/                   # e2e coverage
```

## Adding a New Tool

1. Create your tool file under `src/tools/`
2. Export a `register<Name>Tools(server)` function
3. Import and call it in `src/index.js`
4. Emit a correlated telemetry event for state-changing behavior
5. Add a required-tool assertion and an e2e test where practical

## Commit Style

We follow [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` new feature
- `fix:` bug fix
- `docs:` documentation only
- `perf:` performance improvement
- `refactor:` code change without new feature or fix

## Pull Requests

- Keep PRs focused — one feature or fix per PR
- Add a clear description of what changed and why
- Make sure `npm test` passes before opening a PR

## Reporting Bugs

Open an issue with:
- Node.js version (`node --version`)
- OS and version
- Steps to reproduce
- Expected vs actual behavior
