# Changelog

All notable changes to whosup are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the version matches
`herdr-plugin.toml` and `package.json`.

## [Unreleased]

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
