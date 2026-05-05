# Workflow Recipes

These recipes are copy/paste prompts you can give to Pi after installing `@gtwatts/pi-cmux`.

## Check local CMUX readiness

```text
Run cmux_status with includeCapabilities and includeTree. Summarize whether CMUX is reachable, what workspace is focused, and what browser/terminal surfaces are available.
```

## Open a browser surface and checkpoint it

```text
Use cmux_browser_bootstrap to open https://pi.dev/packages in a CMUX browser surface. Acquire a lock as operator, observe the page, save checkpoint pi-packages-start, then summarize the most important visible content.
```

## Launch a solo researcher

```text
Use cmux_pi_agent to launch an agent alias package-researcher in a split pane. Ask it to inspect this repository and identify improvements needed before npm publishing. Capture its output after it finishes.
```

## Launch a three-agent implementation team

```text
Use cmux_pi_team to create a team named repo-polish with roles planner, coder, reviewer. Goal: improve repo docs, packaging metadata, and verification for the Pi CMUX extension family. Run at least two coordination rounds, share findings between agents, and keep the team live for follow-up.
```

## Browser verification loop

```text
Use cmux_browser_bootstrap for the local dev URL. Observe the page, click through primary navigation, assert expected headings, extract links and buttons, save a final checkpoint named browser-qa-complete, and report issues with selectors or screenshots if available.
```

## Design scaffold loop

```text
Use cmux_design_plan for a premium technical landing page for Pi CMUX. Then use cmux_design_scaffold to create ./design/pi-cmux-landing with three visual variations and an HTML starter. Generate a cmux_design_prompt for a team execution pass.
```

## Team handoff report

```text
Use cmux_pi_team report with synthesis mode for the active team. Then inspect cmux_pi_bridge_events for recent blockers or approvals and produce a final operator handoff with next actions.
```
