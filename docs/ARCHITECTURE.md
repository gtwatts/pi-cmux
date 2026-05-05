# Architecture

`@gtwatts/pi-cmux` is a family package, not a set of unrelated extensions. The package installs four Pi extensions that share assumptions about CMUX workspaces, browser surfaces, Pi agent sessions, event logs, and handoff state.

## Layers

## 1. CMUX Orchestrator

The orchestrator owns local CMUX control-plane operations:

- Workspace lifecycle.
- Pane and surface management.
- Low-level browser surface operations.
- Pi agent launch/capture/message/focus flows.
- Pi team creation, tasking, coordination, reporting, retention, and shutdown.

The orchestrator writes structured run/team/agent state under `.cmux-orchestrator` in the Pi agent directory.

## 2. CMUX PI Bridge

The bridge connects the currently running Pi process to CMUX-aware metadata:

- Session id and launcher context.
- Workspace/surface/agent/team/task linkage.
- Tool-call and turn-end events.
- Session health and stale-session detection.
- Index rebuild/pruning policy.

The bridge is intentionally useful for both live monitoring and post-hoc debugging.

## 3. CMUX Browser Intelligence

Browser Intelligence turns a CMUX browser surface into a safer shared working object:

- A browser surface can have an owner lock.
- Observations create structured summaries of page state.
- Actions include semantic target resolution and postconditions.
- Assertions verify expected state before proceeding.
- Checkpoints preserve continuity.
- Memory records site-specific selectors, workflows, and reusable skills.

This layer is especially important when multiple agents share a browser surface.

## 4. CMUX Design

CMUX Design adds a repeatable design artifact workflow:

- Context gathering.
- Design direction selection.
- Token discipline.
- Scaffolded brief/design/handoff files.
- Critique and browser verification prompts.
- Export command construction for compatible design toolchains.

## Data flow

1. An operator asks Pi to create or inspect a CMUX workflow.
2. Orchestrator calls CMUX CLI/RPC/browser wrappers.
3. Pi Bridge records execution context and structured events.
4. Browser Intelligence manages shared browser surfaces and checkpoints.
5. Design tools create artifacts and prompts that can be executed by solo agents or teams.
6. Team and browser results are gathered back into the operator session.

## State locations

Runtime state should remain local and uncommitted:

- `~/.pi/agent/.cmux-orchestrator/`
- `~/.pi/agent/.cmux-pi/`
- `~/.pi/agent/.cmux-browser-intelligence/`

These directories may include prompts, task context, URLs, local paths, browser snapshots, and event logs.
