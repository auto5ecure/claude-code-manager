# Claude Code Manager

A desktop application for managing Claude Code projects with integrated terminal, type-based workflows, and project documentation.

## Features

- **Project Management**: Add, remove, and organize Claude Code projects
- **Embedded Terminal**: Multi-tab terminal with xterm.js and node-pty
- **Project Types**: Switch between "Tools" and "Projekt" workflows with different system prompts
- **CLAUDE.md Editor**: Edit project-specific Claude instructions
- **Git Integration**: Shows branch name and dirty status
- **Quick Commands**: Command palette (Cmd+P) for common operations
- **Activity Log**: Track commands and activities per project
- **Drag & Drop**: Add projects by dropping folders
- **Screenshot Support**: Paste and save screenshots to projects

## Project Types

### Tools Mode
Deterministic engineering toolbox for maintenance, debugging, and precise execution.

### Projekt Mode
Staff engineering mode for larger features with planning and approval workflow.

Both modes use the same documentation structure:
- `CONTEXT.md` - System overview
- `DECISIONS.md` - Append-only decision log
- `STATUS.md` - Current state

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Cmd+1-9 | Select project by number |
| Cmd+K | Focus search |
| Cmd+P | Quick commands |
| Cmd+L | Activity log |
| Escape | Close modals |

## Development

```bash
npm install
npm run dev          # Start Vite dev server
npm run dev:main     # Watch & compile main process
npm run start        # Launch Electron
```

## Build

```bash
npm run build        # Build for production
npm run dist         # Create distributable
```

## Configuration

Templates are stored in the app's user data directory:
- macOS: `~/Library/Application Support/claude-code-manager/templates/`
- Windows: `%APPDATA%/claude-code-manager/templates/`
- Linux: `~/.config/claude-code-manager/templates/`

Place your custom `tools.md` and `projekt.md` files there to override defaults.

## License

MIT
