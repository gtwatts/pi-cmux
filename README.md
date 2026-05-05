# Pi CMUX Extension Family

A single Pi package that installs the CMUX extension family together:

- `cmux-orchestrator.ts` — launch and coordinate multi-agent Pi teams inside cmux.
- `cmux-pi-bridge.ts` — link Pi sessions to cmux workspaces, surfaces, teams, and task metadata.
- `cmux-browser-intelligence.ts` — semantic browser automation, locks, checkpoints, recovery, and reusable browser memory.
- `cmux-design.ts` — Huashu/Open-Design-inspired design planning, scaffolding, prompts, and export command helpers.

These extensions are designed to work as a family: orchestration creates and coordinates agents, the bridge records session state, browser intelligence makes shared browser work safe/recoverable, and design tools add a repeatable artifact workflow.

## Requirements

- [Pi](https://pi.dev/)
- [cmux](https://github.com/dnakov/cmux) installed and reachable on your machine
- Node.js 20+
- macOS/Linux shell environment with `bash`

Some tools expose wrappers around local commands such as `cmux`, `pi`, `git`, and design/export utilities. Review commands before running high-impact workflows.

## Install

### From npm

```bash
pi install npm:@gtwatts/pi-cmux
```

### From GitHub

```bash
pi install git:github.com/gtwatts/pi-cmux
```

### Local development

From this package directory:

```bash
pi install .
# or try for one run only
pi -e .
```

From the parent `packages/` directory:

```bash
pi install ./cmux-pi-extensions
pi -e ./cmux-pi-extensions
```

## Extension tools

### CMUX Orchestrator

- `cmux_status`
- `cmux_workspace`
- `cmux_surface`
- `cmux_browser`
- `cmux_pi_agent`
- `cmux_pi_team`
- `cmux_notify`
- `cmux_rpc`
- `cmux_cli`

### CMUX PI Bridge

- `cmux_pi_bridge_status`
- `cmux_pi_bridge_sessions`
- `cmux_pi_bridge_events`
- `cmux_pi_bridge_prune`
- `cmux_pi_bridge_policy`
- `cmux_pi_bridge_rebuild_index`
- `cmux_pi_bridge_doctor`

### CMUX Browser Intelligence

- `cmux_browser_doctor`
- `cmux_browser_bootstrap`
- `cmux_browser_focus_and_notify`
- `cmux_browser_mechanic`
- `cmux_browser_observe`
- `cmux_browser_act`
- `cmux_browser_assert`
- `cmux_browser_extract`
- `cmux_browser_lock`
- `cmux_browser_memory`
- `cmux_browser_learn`
- `cmux_browser_skill_pack`
- `cmux_browser_recover`
- `cmux_browser_run_task`
- `cmux_browser_session`
- `cmux_browser_checkpoint_policy`

### CMUX Design

- `cmux_design_status`
- `cmux_design_repo_digest`
- `cmux_design_open_design_digest`
- `cmux_design_direction_pack`
- `cmux_design_plan`
- `cmux_design_scaffold`
- `cmux_design_build_command`
- `cmux_design_prompt`

## Publishing notes

The Pi package catalog at <https://pi.dev/packages> lists packages published to npm and tagged with the `pi-package` keyword. Git install works for users immediately, but npm publishing is the path to catalog visibility.

1. Create a public GitHub repo, for example `gtwatts/pi-cmux`.
2. Update `package.json` repository/homepage/image fields if the repo name changes.
3. Optionally add a package preview with `pi.image` or `pi.video` in `package.json`.
4. Run `npm pack --dry-run` and inspect the tarball file list.
5. Publish with `npm publish --access public`.
6. Verify install with `pi -e npm:@gtwatts/pi-cmux` in a clean shell.

## Security model

Pi extensions execute code with the user's local permissions. This package intentionally interfaces with cmux, shell commands, browser surfaces, and local files. Users should inspect source before installing and should not run untrusted tasks through orchestration tools.

## License

MIT. Change this before publishing if you prefer another open-source license.
