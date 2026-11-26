# Changelog

## 0.3.0

- Add a Neovim tab editor with workspace groups, agent status, and counts.
- Move whole tabs between workspaces on Herdr servers that support `tab.reorder`.

## 0.2.0

- Publish prebuilt Linux and macOS archives for x86-64 and ARM64, with
  SHA-256 checksums and GitHub build provenance.

- Number idle, done, and blocked agents in the agent picker. Use arrows,
  `j`/`k`, and Enter to open any agent.

- Enlarge both popup pickers to 116 columns by 42 rows, with visible row
  ranges, overflow arrows, and title-first constrained layouts.

- Add search, unlimited keyboard navigation, and agent status to pane quick
  jump. Keep pane IDs separate from digit shortcuts.

- Refresh open agent pickers while preserving the selected agent identity.
- Show query hints and a result count in the agent popup.

- Search the agent table by title, harness, status, or location with `/`.

- Remove the agent picker row limit.
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
