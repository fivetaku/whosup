# Changelog

All notable changes to whosup are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the version matches
`herdr-plugin.toml` and `package.json`.

## [Unreleased]

### Added

- Settings panel, "Clicking a pane opens": each browser chooses terminal
  window, web address, or both. Web address opens the pane in a web terminal
  for herdr in a new tab (preset for Ovis, one address per herdr session), so
  the board can be used from another device.
- Settings panel, "Terminal app": the app showing herdr is found
  automatically and a change applies without a restart. When no window shows
  the session, a new one opens in Ghostty or Terminal.
- Live updates: the collector follows herdr's events and open board tabs are
  told at once, so a state change shows in well under a second instead of
  waiting for the next 3 s pass.
- Tab moves between panes, and Enter or Space opens the focused pane.

### Changed

- herdr and git are called without blocking the server, and conversation
  history is read again only when its file changes. Clicks are answered while
  a collect is running.
- Only the cells that changed are redrawn, so keyboard focus and selected
  text survive a refresh.
- `FRONT_APP` is no longer needed to bring the terminal forward on macOS. It
  still works as a starting value; the settings panel overrides it.
- Requests that change something must be sent as JSON
  (`Content-Type: application/json`).
- herdr startup does not open a second tab while a board tab is connected,
  even a hidden one. The `open` action still opens one.

### Fixed

- Enter jumped to the "next" pane even when another pane had keyboard focus.
- The first screen waited for git branch lookups.
- A new terminal window could open twice when the terminal app was slow to
  start.

## [0.1.0] - 2026-11-10

First public release.

### Added

- One browser board for every pane of every running herdr session, with no
  list to register.
- Status band (needs input, failed, answer arrived, running, idle) and a
  "next" line that shows the one pane to look at first and the question it is
  asking.
- Click a card and herdr focuses that pane. On macOS the terminal app can be
  brought to the front.
- Tab title count, favicon and optional desktop notifications while you are in
  another window.
- Panes that need you stay on the board until handled, across midnight and
  restarts. "Seen" snoozes for 30 minutes.
- "Resume" on empty panes after a reboot reopens the folder's latest Claude
  Code conversation.
- Seat order and neglect order, pinned panes, recently closed and stashed
  panes.
- Disconnected state shown explicitly instead of a stale board.
- Light and dark themes, English and Korean.

[Unreleased]: https://github.com/fivetaku/whosup/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/fivetaku/whosup/releases/tag/v0.1.0
