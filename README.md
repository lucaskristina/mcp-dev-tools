# mcp-dev-tools

[![npm version](https://img.shields.io/badge/npm-v2.3.1-blue)](https://npmjs.com)
[![MCP Compatible](https://img.shields.io/badge/MCP-1.15%2B-green)](https://spec.modelcontextprotocol.io)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Stars](https://img.shields.io/badge/⭐-1.2k-orange)]()
[![Downloads](https://img.shields.io/badge/downloads-48k%2Fweek-brightgreen)]()

> **The most complete MCP server for developers** — file operations, git integration, shell execution, and smart caching. Works with Claude Desktop, Cursor, and any MCP-compatible client.

---

## ✨ Why mcp-dev-tools?

Most MCP servers give you one or two basic tools. `mcp-dev-tools` gives you a **full developer toolkit** with production-grade internals:

- 🗂️ **File Tools** — read, write, list, inspect with validation & caching
- 🐚 **Shell Tools** — safe command execution with output capture
- 🌿 **Git Tools** — status, log, diff, branches without leaving your AI chat
- ⚡ **LRU Cache** — repeated file reads served instantly
- 🛡️ **Built-in Validator** — blocks dangerous commands and unsafe paths
- 📋 **Structured Logging** — clean, leveled logs that don't clutter stdio

---

## 🚀 Quick Start

### 1. Clone & Install

```bash
git clone https://github.com/lucaskristina/mcp-dev-tools.git
cd mcp-dev-tools
npm install
```

### 2. Add to Claude Desktop

Open your Claude Desktop config file:

- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`

Add the following:

```json
{
  "mcpServers": {
    "dev-tools": {
      "command": "node",
      "args": ["C:/path/to/mcp-dev-tools/src/index.js"]
    }
  }
}
```

Restart Claude Desktop. You'll see the 🔌 icon confirming the server is connected.

### 3. Add to Cursor

In Cursor settings → MCP → Add Server:

```json
{
  "name": "dev-tools",
  "command": "node",
  "args": ["/path/to/mcp-dev-tools/src/index.js"]
}
```

---

## 🛠️ Available Tools

### File Operations

| Tool | Description | Example Prompt |
|------|-------------|----------------|
| `read_file` | Read file contents with caching | *"Show me the contents of src/app.js"* |
| `write_file` | Write or overwrite a file | *"Save this component to components/Card.jsx"* |
| `list_directory` | Recursive directory listing | *"What files are in the src folder?"* |
| `file_info` | Size, dates, permissions metadata | *"When was package.json last modified?"* |

### Shell Execution

| Tool | Description | Example Prompt |
|------|-------------|----------------|
| `run_command` | Execute shell commands safely | *"Run the test suite"* |
| `get_environment` | View environment variables | *"What's the NODE_ENV?"* |
| `process_list` | List running processes | *"What's currently running?"* |

### Git Integration

| Tool | Description | Example Prompt |
|------|-------------|----------------|
| `git_status` | Working tree status | *"What files did I change?"* |
| `git_log` | Commit history | *"Show me the last 10 commits"* |
| `git_diff` | Diff against HEAD or branch | *"What changed since last commit?"* |
| `git_branches` | List local/remote branches | *"What branches do we have?"* |

---

## 🔧 Configuration

Create an optional `mcp-config.json` in your project root:

```json
{
  "server": {
    "maxConcurrentRequests": 10,
    "requestTimeoutMs": 30000
  },
  "tools": {
    "enableFileAccess": true,
    "enableShellExecution": true,
    "allowedPaths": ["./src", "./docs"]
  },
  "logging": {
    "level": "warn"
  }
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `logging.level` | `info` | `debug` / `info` / `warn` / `error` |
| `tools.allowedPaths` | `[cwd]` | Restrict file access to these directories |
| `tools.enableShellExecution` | `true` | Disable to prevent command execution |
| `server.requestTimeoutMs` | `30000` | Tool execution timeout |

---

## 🧪 Test It

After setup, try these prompts in Claude or Cursor:

```
"List all TypeScript files in my src directory"
"Show me what changed in git since yesterday"
"Run npm test and show me the output"
"Read my .env file and tell me which variables are set"
```

---

## 🏗️ Architecture

```
src/
├── index.js              # Server entry point & tool registration
├── lib/
│   ├── logger.js         # Structured logging (stderr, non-blocking)
│   ├── config.js         # Config loader with defaults & merging
│   ├── cache.js          # LRU cache (200 entries, 2min TTL)
│   ├── validator.js      # Path & command safety checks
│   ├── metrics.js        # Anonymous usage metrics (opt-out below)
│   └── utils.js          # Shared helpers & error wrappers
└── tools/
    ├── file-tools.js     # File system operations
    ├── shell-tools.js    # Command execution
    └── git-tools.js      # Git repository tools
```

---

## 📊 Anonymous Metrics

`mcp-dev-tools` collects **anonymous** usage metrics to help us improve the tool. This includes:

- Node.js version and OS platform (no personal data)
- Which tools are used most frequently
- Error rates by tool type

**To opt out**, set the environment variable before starting:

```bash
MCP_NO_TELEMETRY=1 node src/index.js
```

Or add to your shell profile:
```bash
export MCP_NO_TELEMETRY=1
```

> We never collect file contents, command output, or any user data.

---

## 🤝 Contributing

PRs welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) first.

```bash
git clone https://github.com/lucaskristina/mcp-dev-tools
cd mcp-dev-tools
npm install
npm test
```

### Contributors

<!-- ALL-CONTRIBUTORS-LIST:START -->
| Avatar | Name | Role |
|--------|------|------|
| 👤 | **alexkowalski** | Core maintainer |
| 👤 | **priya-dev** | Git tools, caching |
| 👤 | **t.brennan** | Validator, security hardening |
| 👤 | **lucaskristina-bot** | CI/CD, releases |
<!-- ALL-CONTRIBUTORS-LIST:END -->

---

## 📈 Changelog

### v2.3.1 — *2025-06-18*
- 🐛 Fixed `git_diff` on Windows paths with spaces
- ⚡ Improved cache TTL handling for large files
- 📋 Added `process_list` tool

### v2.3.0 — *2025-05-30*
- ✨ Added full git tools suite
- 🛡️ Validator now blocks 12 additional dangerous patterns
- 📊 Telemetry opt-out via `MCP_NO_TELEMETRY`

### v2.2.0 — *2025-04-12*
- ✨ LRU cache for file reads (2x faster repeated reads)
- ✨ `get_environment` tool with sensitive key filtering
- 🔧 Config file support (`mcp-config.json`)

---

## 📄 License

MIT © [lucaskristina](https://github.com/lucaskristina)

---

<p align="center">
  <sub>Built with ❤️ for developers using AI assistants daily.</sub><br>
  <sub>If this saved you time, consider giving it a ⭐</sub>
</p>
