# Changelog

## Unreleased

- Refresh open agent pickers while preserving the selected agent identity.
- Show query hints and a result count in the agent popup.

- Search the agent table by title, harness, status, or location with `/`.

- Remove the agent picker limit. Keep digits for the first ten agents and
  navigate every row with Vim keys, arrows, and Enter.
- Keep the agent picker open until selection or cancellation.

## 0.1.0

- Add a Herdr plugin with even-layout actions and pane and agent popup pickers.
- Add `plugin register` for Cargo installations and `plugin open pane|agent`.
- Resolve plugin popup targets from Herdr's invocation context.
- Add CLI version reporting and locked build and release checks.
- Add agent table headings, colored status icons and jump numbers, compact tab
  labels, and terminal-width title truncation.

## 0.0.1

- Publish the standalone tmux-style layout CLI.
