# Changelog

All notable changes to whosup are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the version matches
`herdr-plugin.toml` and `package.json`.

## [Unreleased]

## [0.2.0] - 2026-11-20

### Added

- The one-line installer has a screen for a person at a terminal: a header,
  the two questions (where sessions run, then which app) as arrow-key menus
  (Up/Down or k/j and Enter; a number picks at once) that fold into one
  "✓ Sessions run in: Desktop app" line, ✓/…/✗ progress lines without the
  "whosup:" prefix, explanations wrapped to the terminal's width with a
  hanging indent (a path or address is never split, and paths in your home
  folder are shown with ~), and, on the herdr plugin path, a summary that
  starts with what to do next. Colors are bold, green for ✓ and red for ✗
  only, readable on light and dark backgrounds; NO_COLOR turns them off and a
  locale that is not UTF-8 gets ASCII marks. The menu changes the terminal
  only with `stty -icanon -echo` (Ctrl-C still stops the install) and puts
  the settings and the cursor back however it ends. With no terminal, with
  TERM empty or dumb, in CI, with WHOSUP_NO_SETUP, or with WHOSUP_UI=plain the
  installer prints exactly what it printed before.

- The same screen carries on past the installer's own lines: the terminal
  first-run setup replaces its title and "checking this machine…" with a
  progress line that turns into "✓ Detected: …" in place, asks its questions
  with the same arrow-key menu (folding into "✓ Herdr app sessions open in:
  terminal window"; Enter on the marked value still saves nothing, a number
  or a moved choice is saved), and says nothing when there is nothing to ask.
  The standalone install summary starts with "✓ whosup is installed", then
  what to do next, what was installed (paths in your home folder with ~),
  anything good to know, the two commands worth knowing (turning start at
  login on or off, and whosup help), and where settings change. `whosup
  setup` and a `herdr plugin install` run by hand follow WHOSUP_UI the same
  way (not given: rich only on a terminal with TERM set, never on Windows).

- On that screen, a folded answer line and the key hint line are wrapped to
  the terminal's width too (the hint breaks only between its parts, "1 after
  120s"); the progress line of the plugin install turns into its ✓ line in
  place unless the first-run setup printed something in between; the
  standalone summary writes its commands as `~/.local/bin/whosup …` and, when
  that folder is not on your PATH, gives the line that puts it there; nothing
  but the key hint and the last footnote is dimmed. Pressing Enter on the
  marked value no longer adds "Nothing set by hand" under the folded line.
  When a menu cannot switch the terminal, that question (also the second one)
  is asked the numbered way without repeating the opening paragraph. Ctrl-C in
  the first-run setup of a standalone install says, in your language, that
  the app installed with it is still in place, without an English diagnostic
  line. A menu also puts the terminal back when its process exits, and the
  board and helpers no longer inherit the installer's WHOSUP_UI values.

- One-line installer for macOS and Linux:
  `curl -fsSL https://raw.githubusercontent.com/fivetaku/whosup/main/install.sh | sh`.
  It looks at the computer and takes one of three paths: with herdr 0.9.0 or
  newer, a herdr plugin; with no herdr but herdr-core (the Herdr desktop app,
  or another app that runs its own core, even one that is not running now
  but has run on this computer), a standalone install; with nothing to run
  sessions in, it asks what you want, installs that first, then whosup (next
  entry). It needs
  Node 22.13 or newer and installs nothing without it. An older Node earlier
  on the PATH does not hide a newer one: the PATH and the usual install
  places (Homebrew, nvm versions newest first, the fnm default) are tried in
  order and the first Node that is new enough is used. It always ends with a
  summary of the path taken, the board's address and the next step, so an
  agent running it without a terminal can pass that on. Running it again
  does not switch paths.
- On a computer with nothing to run sessions in (no herdr, no herdr-core, no
  Herdr app, no Ovis app), the one-line installer asks what you want to use
  and installs it for you, then whosup. It asks up to two questions, by
  number: *Desktop app* or *Terminal*, and for an app, *Herdr* or *Ovis*.
  The line under *Desktop app* names the apps the computer can install
  (Herdr or Ovis, or the only one there is), so they show from the first
  question. Enter takes the choice marked `*`: Desktop app, then Herdr; a question
  left for 120 seconds goes on with it too. The Herdr app is installed with
  its own installer and the Ovis app from its release files (about 175 MB,
  checked against the release's checksum and, on macOS, its signature; on
  macOS it goes into `~/Applications`), each followed by a standalone
  install of whosup; herdr goes into `~/.local/bin`, followed by the plugin.
  No administrator password is asked for. Only what the computer can
  install is offered, with one line saying why the other is not: the Herdr
  app on Apple-silicon Macs and on Linux (x86_64, arm64); the Ovis app on
  macOS 13 or newer and, on Linux, only where its desktop libraries and FUSE
  are already there. Where the Herdr app cannot be installed the app is
  Ovis, and where neither can, herdr is installed without a question. With
  no terminal to ask in (an agent, a script, `CI`, `WHOSUP_NO_SETUP=1`) the
  default is installed. `WHOSUP_ENV=herdr-app|ovis-app|herdr` picks without
  asking; a value this computer cannot install prints the reason and
  installs nothing. An app that is already in the applications folder but
  was never opened is not installed again: whosup is installed next to it.
  If the app cannot be installed, the installer shows what its installer
  printed, says what failed and where to get the app yourself, and installs
  nothing of whosup; no half-downloaded file is left behind. The app has to
  be opened once before its sessions show on the board: the installer opens
  it where it also opens the browser, and otherwise the summary says to open
  it. `whosup uninstall` does not remove an app installed this way and says
  so in one line. When something is already on the computer nothing of this
  is asked and the paths above are taken as before.
- Standalone install, without herdr: the program goes to
  `~/.local/share/whosup/app`, the `whosup` command to `~/.local/bin`,
  settings to `~/.config/whosup` and state to `~/.local/state/whosup` (a
  `~/.config/whosup` that already holds whosup's database keeps being used).
  An `XDG_DATA_HOME` or `XDG_STATE_HOME` that is not an absolute path is
  ignored. The install writes an install record, `install.json`, next to
  the program: the folders and the Node it uses, so the `whosup` command
  and start at login keep using the same ones. When that Node is gone or is
  no longer 22.13 or newer, another one is looked for.
  The `whosup` command has `start`, `stop`, `status`, `open`, `setup`,
  `update`, `uninstall [--purge]`, `autostart on|off|status` and `help`. An
  update keeps settings and history, restarts a board that was running, and
  puts the old version back if the new one fails to install or if a board
  that was running does not start in the new version. Uninstall keeps
  settings and history unless `--purge` is given; `--purge` removes only the
  settings and state folders written in the install record, and only once
  the program itself is fully removed. When something could not be removed,
  uninstall lists it and ends with 1, and when start at login could not be
  turned off (or, on Linux, the user service could not be stopped) it stops
  before removing the program.
  `whosup stop` on Linux stops the `whosup.service` user service too; when
  that service does not stop, it prints the command to type and ends with
  an error.
  Another program already named `whosup` in `~/.local/bin` is left alone.
- The standalone install is careful with what is already there. A folder in
  the program's place that the installer did not put there is neither run
  nor changed: the installer says so and ends, and uninstall leaves it as it
  is. A second install started while one is running says so and ends without
  changing anything, however long the first one takes; `whosup uninstall`
  and `whosup autostart on|off` do the same while an install or update is
  running. An install stopped part-way (Ctrl-C, also at a
  first-run setup question, a kill, a closed terminal) is undone: a new
  install removes what it had put in place, an update puts the version that
  was here before back and restarts a board that was running; when that
  board could not be started again, the installer says so and names
  `whosup start`. What an unfinished install left behind is removed only
  after the board started from it is stopped and start at login is turned
  off; when that cannot be done, the folder is left as it is and the
  installer says what to do and ends with an error. Settings and history
  are kept.
- Start at login for the standalone install: a LaunchAgent
  (`dev.whosup.board`) on macOS, a `systemd --user` service
  (`whosup.service`, always in `~/.config/systemd/user`) on Linux. Starting
  at login opens no browser tab. `whosup autostart off` turns it off, and an
  update keeps that choice. On macOS, when the login item is set but could
  not be loaded right now, the install summary, `whosup autostart on` and
  `whosup status` say that it starts from the next login. When
  `whosup autostart off` cannot remove the login item's file, it names the
  file and ends with 1. When the service manager (launchd or systemd) still
  has the login item, `whosup autostart off` and `whosup uninstall` do not
  say it is off: they print the command to type and end with 1.
- Sessions of desktop apps that run their own herdr-core (such as the Ovis
  desktop app) show on the board, in desks of their own. While the app is
  running, new session, close and resume work from the board: whosup asks
  the app's own local server on 127.0.0.1 to do it, and reads and uses no
  token. A new session opens as a tab in the desk you pick or as a new desk
  in that app, and whosup types the agent command into it. A click brings
  that app's window forward (macOS) and opens the session in a browser tab
  at the app's local address, because the app offers no way to pick a
  session inside its window from outside; once you have set *Sessions open
  in* yourself, a click follows that choice instead. Turning the desk off
  and on is not available for these sessions, and a server that asks for a
  token or a login is not operated at all. When the app is not running,
  the board says so instead of an error and starts nothing: new session and
  resume say to start the app (`app_required`), and close still works by
  ending that terminal in the core. Closing the app
  does not close its sessions on the board: while the app's core keeps
  running they stay, and when the core is off too they are marked
  unreachable and move to recently closed after the unreachable timeout
  (24 hours by default). After a board restart with the app closed they show
  under the core's name. `WHOSUP_CORES`, `HC_SOCKET` or `HC_SESSION`, when
  set, come first: a core left out of them is not read. When the app's
  name is unknown (outside macOS, for example) or *Herdr app sessions open
  in* is terminal window, the session opens in a terminal window
  (`hc attach`); with no app name to give, the board says the session's
  core is not running when that core is off. First-run setup, settings and
  the install say in one line that the app's sessions show on the board
  too; a standalone install that asked nothing (no terminal) carries that
  line in its summary once the board is up.
  The hint under *Herdr app sessions open in* in settings says that the
  choice applies to these sessions as well.
- Auto-detect finds those apps: it asks ovis servers on 127.0.0.1, on ports
  7317–7330 and on the ports in ovis's bridge registry
  (`~/.config/ovis/bridges`, or its old name `~/.config/herdr-web-ui/bridges`).
  From the registry it uses only each entry's port and process id; the
  token is not taken out, kept or written anywhere. An entry is used only
  when its process is alive and, on macOS and Linux, is the one listening
  on that port (when that cannot be checked, the entry is used as before).
  A server's core is read only when the server says it shows herdr-core,
  under the name the server reports. When that app's web terminal opens
  without a login, its address is filled in for the desk.
  An app started after the board is found without pressing
  re-detect: the board looks at the registry again every 10 seconds, and
  when the server of an app that has just started does not name its core
  yet, it asks again every 5 seconds, for up to about a minute.
- `WHOSUP_CORES`: which other herdr-core cores to read besides the Herdr
  app's (`default`): names separated by commas, `all`, or `none`. Unset,
  auto-detect decides. `HC_SOCKET` or `HC_SESSION` still pins whosup to one
  core. Core names are letters, digits, `.`, `_` and `-`, up to 80
  characters; `.` and `..` are refused everywhere. An `HC_SESSION` that
  does not fit that rule is ignored, as if it were not set. When two names
  point at the same socket, that core is read once, under the first name.
- `auto.json`: `cores` (what the board uses for each core:
  `{ name, app?, url?, focus }`), `summary.cores` (`[{ name, app, web }]`)
  and `summary.herdr_core` (`{ running, view_only }`). `focus` is `true`,
  `false` or left out; the Herdr app's core is view-only only when it says
  `focus: false`. For another app's core, `focus: false` means the app
  cannot be told which session to show in its window: with a `url`, new
  session, close and resume go through the app's local server.
- New result codes from `POST /api/open`: `focused_app_only` (the app window
  was brought forward, pick the session inside the app), `app_closed` (the
  app is not running, or, when the app's name is unknown, the session's
  core is not running), `app_raise_failed` (the app is running but its
  window could not be brought forward), `app_raise_unsupported` and
  `core_unavailable` (409: the session belongs to a core that is no longer
  read, so nothing was opened; the session is left as it is and is not moved
  to recently closed). Sessions
  of a view-only core answer `not_supported` (409) to close, resume, new
  session and desk on/off. For a session of an app that shows its core
  through its own local server, a refusal carries the reason instead:
  `app_required` (the app is not running), `token_required` (its server
  takes nothing without a login) or `app_no_answer` (the server did not
  answer in time, so the request may or may not have been done), with the
  app's name in `app`. Answers to open, resume, new session and close carry
  `means` (how it was done) and, when the app's server is up, `url` (that
  session's address there). `GET /api/board` has `cores` (what works for
  each herdr-core core being read) and each of those sessions has
  `features`. The request body takes an optional `web`
  (boolean): whether that click opened the session's web terminal tab.
- Installer and install-time switches, read from the environment of the
  install command: `WHOSUP_INSTALL_MODE=plugin|standalone`,
  `WHOSUP_ENV=herdr-app|ovis-app|herdr` (what to install on a computer with
  nothing to run sessions in), `WHOSUP_ENV_TIMEOUT=<seconds>` (how long
  herdr's installer, or an app's installer and each of its downloads, may
  take before it is stopped, 900 by default),
  `WHOSUP_REF=<git ref>`, `WHOSUP_NO_LOGIN_START=1` (new), and the existing
  `WHOSUP_NO_SETUP`, `WHOSUP_NO_AUTOSTART`, `CI` and `WHOSUP_LANG`, which
  the installer honours too. Also `WHOSUP_SETUP_TIMEOUT_S` (seconds a
  first-run question waits, 120 by default) and `WHOSUP_SETUP_CONSOLE=1`
  (ask in the console on a Windows install too, for checking on a machine;
  off by default).
- Windows support, as a herdr plugin: Windows-only entries run with `node`,
  with `win-` actions (`win-start`, `win-stop`, `win-status`, `win-open`,
  `win-desks-apply`, `win-desks-status`, `win-autoconf`, `win-doctor`). The
  Windows build step checks Node only: it asks nothing and detects nothing,
  and the board asks on first open. The one-line installer and the
  standalone install are not available on Windows.
- Settings, "Sessions open in": terminal window, web terminal, or both, saved
  on the server as the default for every browser; "only in this browser"
  applies it to that browser only. Web terminal opens the session in a web
  terminal for herdr in a new tab (preset for Ovis, one address per desk), so
  the board can be used from another device.
- Settings, "Terminal app": the app showing herdr is found automatically and
  a change applies without a restart. The buttons list the detected apps.
  When no window shows the desk, a new one opens in Ghostty or Terminal.
- Live updates: the collector follows herdr's events and open board tabs are
  told at once, so a state change shows in well under a second instead of
  waiting for the next 3 s pass.
- Tab moves between sessions, and Enter or Space opens the focused session.
- Herdr app sessions: when herdr-core is running, each of its terminals is a
  session as well, one desk per space of the Herdr app. Status and the
  question text come from the core. A click jumps to that session in the
  Herdr app and brings the app forward (or opens the session in a terminal
  window when the app is not open). Close, resume, new session and turning a
  desk off and on work as they do for herdr desks. whosup reads the core's
  socket and never starts a core that is not running. `WHOSUP_RUNTIMES` picks
  what to read.
- Herdr app sessions: an agent stopped at its "trust this folder?" prompt
  shows as needing input. The core has no status for it yet, so this one
  prompt is read from the screen, by the same rule sessions in herdr desks
  use.
- Herdr app sessions: an agent that goes back to idle right after finishing
  (Codex) stays "finished" until the turn has been looked at, in the app or
  by opening the session.
- Web terminal: a Herdr app desk opens in a web terminal only when it has its
  own address (the field shows even when that desk is the only one on the
  board); the web terminal button fills the address field clicked last, so a
  per-desk port is one edit. An address that does not parse is refused, and a
  desk whose own address is wrong opens no web tab instead of falling back to
  another desk's address. The tab goes to the clicked session on every click,
  and a tab the browser blocked is reported instead of "moved". With "web
  terminal" chosen, a session that has no address still brings its terminal
  or the Herdr app forward.
- First-run setup: the first time the board opens, it shows the detected
  environment and, for each item, the choices that were detected, with the
  value in use picked. Once something to run sessions in is found (a herdr
  desk, the Herdr app or its core, an app that runs its own core, or a web
  terminal), detected-environment items it found none of are left out there;
  settings still lists them all. "Sessions open in": terminal window, web
  terminal and both, shown only when a web terminal matched to a desk (ovis
  and the like) is detected; a row with a single choice is not shown in
  first-run setup (in the board or in the terminal) and is not saved, while
  settings still shows it. *auto* does not count as a choice there, so one
  terminal app plus auto is not asked either, the same as in the terminal.
  When no row is left, the board says there is nothing to choose right now:
  whosup starts with what it detected, and settings can change it any time.
  "Terminal app": the detected apps and auto. "Herdr app sessions
  open in": Herdr app or terminal window, when the Herdr app or herdr-core is
  detected. "Command to run in a new session": the detected agents (claude,
  codex). "start with these" saves only the rows you picked yourself on the
  server as values you set, which auto-detection does not change afterwards;
  a row you left alone is not saved and keeps following auto-detection, and
  items already set in settings or the environment stay as they are unless
  you touch them. EN / 한 buttons at the top switch the board's language. It
  shows once, also when it is closed with ✕ or Esc (nothing is saved then),
  and can be opened again from settings.
- Until first-run setup is confirmed, the board detects again at most once
  every 5 seconds, so a web terminal started after whosup still shows up as a
  choice.
- Settings, "re-detect": checks the environment again without a restart
  (`POST /api/autoconf/refresh`). Values you set do not change.
- Setting `core_target` (`WHOSUP_CORE_TARGET`: `app` by default, or
  `terminal`), shown as "Herdr app sessions open in". With `terminal`, a
  Herdr app session always opens in a terminal window with `hc attach`, even
  when the app is open.
- `auto.json`: `summary` has `options`,
  `{ terminal_apps: [{ name, showing, opens_new }], agents: [] }`.
- First-run setup at install: installing from a terminal asks first-run
  setup's questions right there, only for items that have more than one
  choice on this machine. Each question says in one line what it decides, and
  the summary above them lists only what was detected. Enter keeps the value
  marked `*` (the auto-detected one) and a number sets your own. The numbers
  go to `setup.json` in the plugin config dir, and the board saves them as
  values you set and does not ask again. When no number was chosen (Enter on
  every item, or nothing to ask), nothing is saved and the board shows
  first-run setup once on first open, with what it detects then.
  Installed without a controlling terminal (an agent, a cron job), nothing is
  asked and the board asks on first open; the same goes for an install run in
  the background of the terminal and for Windows, where herdr runs the
  install step without a visible console. A script run from a terminal is
  still asked; add `WHOSUP_NO_SETUP=1` to skip the questions. Ctrl-C at a
  question cancels the install itself: nothing is installed or saved, and
  nothing more is printed. An update or reinstall asks nothing;
  `WHOSUP_SETUP=1` or `node scripts/setup.mjs` asks again (Enter then leaves
  an item as it is set now). `WHOSUP_SETUP=1` does not work on Windows: run
  `node scripts\setup.mjs` by hand there, or use "open first-run setup
  again" in settings. `WHOSUP_NO_SETUP=1` skips the questions. These
  switches, `WHOSUP_NO_AUTOSTART` and `CI` included, are off when empty, `0`,
  `false`, `no` or `off`, and on with any other value.
- The board starts after a first install: when herdr is running, it comes up
  as soon as the install finishes and the browser opens (not over SSH or
  with `OPEN_BROWSER=0`). When herdr is not running, an install from a
  terminal says what to type and where (`herdr`, in that terminal) and shows
  the board's address; the board starts with it. Commands to type are printed
  on a line of their own. An update or reinstall leaves a running board alone
  and, when herdr is running, starts one that is not running; numbers chosen
  during an update take effect when the board restarts, and numbers chosen
  with `node scripts/setup.mjs` reach a running board without a restart.
  `WHOSUP_NO_AUTOSTART=1` turns this off, and with `CI` set nothing is asked
  or started.

- Sessions of an app that runs its own core (the Ovis desktop app) open in
  the app window instead of a browser tab when the installed app knows the
  `ovis://open` link (an Ovis version with that link, pending upstream; the
  released 0.5.3 does not have it). whosup checks the installed app itself
  — on macOS the app bundle's `Info.plist` (`CFBundleURLTypes`), on Linux a
  `.desktop` file with `x-scheme-handler/ovis` or `xdg-mime query default`,
  on Windows `HKCU\Software\Classes\ovis` — and remembers the answer until
  that file changes. A click, and a session just opened from **new session**
  or resumed, then opens `ovis://open?pane=<session>&view=terminal` with the
  system opener (`open`, `xdg-open`, `cmd /c start`, as an argument list,
  never a shell line; only the session id read from the core goes into the
  link, URL-encoded): the app window comes forward with that session picked.
  The session's `focus` means is `app_link` on the board. If the opener
  fails, whosup opens the session's browser tab instead and the board says
  so; a click that asks for no window (web terminal chosen) still opens only
  the tab. Results say which way was used (`opened`: `app_link` or
  `browser`). Without the link, and for herdr, Herdr app and terminal
  sessions, nothing changes. On macOS, if the app is in both
  `/Applications` and `~/Applications`, both copies must know the link
  (otherwise the link could start the other copy); an app installed
  elsewhere is treated as not knowing it. On Windows `cmd.exe` and `reg.exe`
  are run from the system folder, and a session id with `:` (`w1:p1`) is
  passed with a plain `:` because `cmd` reads `%` as a variable. The
  installer's closing line about those sessions says the app window when
  the link is known, and the browser tab otherwise.

### Changed

- macOS permissions are used only when they are needed. While the app has a
  window on screen, a click on a session asks for none and no system dialog
  appears. When the app has no window on screen (minimized or hidden),
  whosup first reopens the app, which needs no permission and brings a
  minimized window back; only when that brings no window back, and for
  split screen, does it use the Accessibility and Automation (System
  Events) permissions. Whether you have them is read without asking. If
  you have already given both, nothing changes: minimized windows are
  restored and split screen works as before.
- A permission that is missing or was denied is said on the board. Denying
  the Automation dialog used to leave the board silent; it now shows a
  notice of its own, apart from the one for Accessibility, also when the
  answer came after the click had been answered. The notice no longer looks
  like the red *disconnected* mark and its text is no longer in a tooltip:
  press it to read what does not work, where to turn the permission on
  (System Settings → Privacy & Security → Accessibility, or Automation →
  System Events) and that whosup has to be restarted afterwards. The app it
  names is the one macOS asks about, the app that started whosup; it used
  to say "node".
- Without those permissions whosup cannot tell which window is minimized:
  when another window of the same app is on screen, a minimized one stays
  where it is.
- The installer says less, and says it once. What herdr's installer,
  `herdr plugin install` and an app's installer print is folded into one
  line when they succeed and shown in full when they fail. The board's
  address and what to do next are said once, in the summary; first-run
  setup no longer repeats them when the installer called it, and "nothing
  to choose" is no longer followed by "the board will ask". Where no
  browser opens by itself (SSH, `OPEN_BROWSER=0`), the summary says so.
- herdr's installer has a time limit, the same one as an app's installer.
  When the one-line installer installs herdr first, herdr's installer is
  stopped if it has not finished within 900 seconds, and the message says
  so; it used to run for as long as it took. `WHOSUP_ENV_TIMEOUT=<seconds>`
  changes the limit. `herdr plugin install` has none.
- A command the summary tells you to type runs as typed. When the folder
  herdr is in is not on your PATH, the command is written with its full
  path, and one line says how to add the folder to the PATH for terminals
  opened from then on. Before, the summary said to add the folder and open
  a new terminal, and right below it to type `herdr`.
- The installer and the board name the same terminal app. With no herdr
  window open yet, auto-detect (lane L4) takes the terminal the command was
  typed in (`TERM_PROGRAM`, or `TERM`) before the list of installed apps.
- An empty board says what to do next. When no session has an agent
  running, the next line reads "open a new session". An empty session with
  no conversation to continue has a **start agent** button instead of
  **resume**.
- New session: going into a folder in the list picks it, so the open button
  is ready without pasting a path.
- First-run setup has EN / 한 buttons for the board's language. English
  stays the default.
- First-run setup closed with ✕ or Esc counts as done and does not come
  back on every load; "open first-run setup again" in settings still shows
  it.
- First-run setup no longer turns auto-detected values into values you set:
  only the rows you picked are saved.
- First-run setup asks about the terminal app only when a herdr desk is
  running, in the terminal and on the board alike: with no herdr, a herdr
  that was just installed, or a herdr that is not running, there is no
  terminal window to bring forward yet. The *Terminal app* item in settings
  stays. *Herdr app sessions open in* is asked only when the Herdr app is
  here (its `herdr-app` command, or its own core running); the core of
  another app does not count.
- An install where no number was chosen (nothing to ask, no terminal, no
  answer in time) no longer counts as finishing first-run setup: the board
  asks once on first open.
- Answering every question of the terminal first-run setup, even with Enter
  only, now counts as finishing it: `setup.json` gets a `"done": true` mark
  (with only the numbers chosen, so items left on Enter keep following
  auto-detect) and the board does not ask the same questions again. Before,
  the board's first-run setup asked them a second time. A timeout, Ctrl-C or
  a closed terminal still leaves it for the board; `setup.json` files without
  the mark, and asking again (`WHOSUP_SETUP=1`, `whosup setup`), work as
  before. The terminal line after Enter-only answers now says that nothing
  was set by hand and auto-detect keeps applying. Because that `setup.json`
  is kept, a reinstall afterwards (even before the board was opened) counts
  as an existing install and asks nothing, as it already did after a number
  was chosen; `whosup setup` asks again.
- First-run setup in the board titles itself "First-run setup · what was
  detected" when there is nothing to choose, instead of asking to pick.
- The installer's menu and terminal-read helpers get their code through an
  environment variable set for that one command, and their command line is
  only `node -e eval(process.env.WHOSUP_JS)` and the arguments, so a
  terminal that shows the running command in its window title no longer
  shows the whole inline script. They do not rename the process: on macOS
  that made the title run on into the environment variables.
- The app brought forward for a Herdr app session is `HERDR_APP_NAME`, else
  the name auto-detect found, else `Herdr`. `HERDR_APP_NAME` is never used
  for another app's core.
- The socket in a core's `core.lock` comes first; a socket auto-detect saw
  earlier is used only when `core.lock` or its socket is missing, and never
  for a core named with `HC_SESSION`.
- When `herdr-app` handles more than one core (a rare setup), a click no
  longer jumps to the session inside the app, because `herdr-app` cannot
  tell which core a session belongs to. The session opens in a terminal
  window attached to its own core (`hc attach`).
- `node scripts/doctor.mjs` reports the Herdr app's core (`default`, or
  `HC_SESSION`) as running by its own socket only; another app's core no
  longer counts.
- A click that does not raise a window marks a session of a view-only core
  as seen only when it opened that session's web terminal tab.
- Errors from herdr-core no longer include the socket path: "herdr-core is
  not running", or "could not reach the core" with the error code.

- The board opens in English by default. Korean is chosen with the EN / 한
  buttons in first-run setup and in settings (or with `?lang=ko`) and
  remembered per browser; the browser language is no longer used to guess.
- herdr and git are called without blocking the server, and conversation
  history is read again only when its file changes. Clicks are answered while
  a collect is running.
- Only the sessions that changed are redrawn, so keyboard focus and selected
  text survive a refresh.
- `FRONT_APP` is no longer needed to bring the terminal forward on macOS. It
  still works as a starting value; settings overrides it.
- Requests that change something must be sent as JSON
  (`Content-Type: application/json`). A request body over 4096 bytes is
  answered with 413 (`body_too_large`).
- herdr startup does not open a second tab while a board tab is connected,
  even a hidden one. The `open` action still opens one.
- One name for each thing, on the board and in the docs: a terminal on the
  board is a *session* (was pane, cell or card) and the group it sits in is a
  *desk* (was herdr session or row). "first-run setup", "auto-detect",
  "settings" and "web terminal" replace "first-run card", "auto setup",
  "settings panel" and "web address". Screen labels follow: "Sessions open
  in", "Web terminal address", "+ new session", "Command to run in a new
  session".

### Fixed

- The window-raising helper (macOS) now quits when whosup goes away. Its
  input loop compared the length of what it read with the number 0, but the
  real JavaScript bridge reports that length as the text "0", so after the
  board stopped the helper kept reading an empty input forever at full CPU.
- One unreadable reply from herdr no longer stops the board: only that
  request fails ("unreadable reply").
- A macOS notification whose text is cut at 160 characters right where a
  quote or backslash stands is sent again. The text was escaped before it was
  cut, which could leave a lone backslash that broke the notification.
- Clicking a finished session when no window could be opened (window raising
  off or not supported here) no longer marks it as seen.
- Clicks from two browsers whose clocks differ are no longer dropped. Each
  board page now names itself, click order is compared within one browser,
  and clicks from different browsers are taken in the order they arrive.
- The installer no longer swaps whosup's own Node while another whosup
  install holds the install lock; it stops with "another whosup install is
  running" instead.
- If an update was cut off right after it moved the old version to
  `app.old` (power loss, `kill -9`), the next installer puts that version
  back before it does anything else, so a failing install still leaves you
  with the version you had.
- The one-line installer installs the tagged release (v0.2.0) instead of
  whatever is on the main branch. `WHOSUP_REF` still picks any branch, tag
  or commit.
- The installer, `whosup stop` and `whosup uninstall` take less on trust.
  "The board is running" now means that what answers on the board's port
  says it is whosup and that it belongs to this install; another program
  that happens to answer there no longer counts, and the board is started
  next to it. `whosup stop` stops only a process that is this install's
  board: a leftover pid file whose number another program has since been
  given is cleared and that program is left alone. When launchd or systemd
  cannot be asked whether the start-at-login entry is still loaded, whosup
  says so and prints the command to check with, instead of reporting it as
  off. `whosup uninstall --purge` removes settings and history only from
  whosup's own folders, whatever the install record says, and not at all
  when the program folder turns out to be someone else's; an empty settings
  or state folder it could not remove is listed. The installer does not
  overwrite an `install.json` that is not whosup's, does not run a
  `scripts/standalone.sh` that is a link to somewhere else, does not write
  its lock through a link, stops a board that an unfinished install started
  from another state folder before clearing that install away (and leaves
  the folder alone when it cannot), and puts everything back and stops when
  the program folder changes under it in the middle of an update. From the
  walks on a real machine: when the installer has already put an app (or
  herdr) in place and a later step fails, it now says that the app is still
  there and can be used or removed, instead of "nothing was changed" (a
  failure message that ended with that sentence now ends with "whosup was
  not installed" instead); the
  three internal lines (`whosup setup: …`, `whosup listening at …`,
  `whosup: start at login: …`) no longer appear in the output of a successful
  install, they go to `install.log` in the state folder and are shown when
  the install does not finish (cancelled at the first-run questions, the
  install record could not be written, an update whose board did not come
  back) or the board could not be started; the installer's PID passed to
  `whosup uninstall` and `autostart` (`WHOSUP_INSTALLER_PID`) is only
  honoured when that process really is an ancestor of the command, so a
  lock held by someone else is never reused; `WHOSUP_ENV=herdr-app` or
  `ovis-app` attaches to an app that is already in the applications folder
  instead of installing a second copy or failing with "already there" (for
  the Herdr app only when its core, herdr-core, is there too; without the
  core the Herdr installer runs again); app downloads
  accept https only, including redirects; on Linux an app opened by the
  installer gets a clean environment, without the installer's own variables
  and extended PATH; and `whosup uninstall` lists the folders an app
  installed together with whosup keeps, next to the line that says the app
  itself was left in place.
- The buttons that appear over a session (pin, stash, close) and the button
  at its lower right covered the session's text. Every session now keeps a
  band free for them.
- The agent command of a new session could show twice in its terminal,
  because it was typed before the shell was ready. whosup waits for the
  shell's prompt first (2 seconds at most).
- A message on the board (the result of a click) could go by unseen: it
  timed out even while the board's tab was hidden. It now sits at the lower
  right, stays for 6 seconds (was 4.5) and, when the tab is hidden, waits
  until it is visible again.
- The folder path field of new session is no longer spell-checked.
- An ovis server was matched to a herdr desk by name only. When whosup knows
  the server's `HERDR_SOCKET` and herdr lists a desk of the same name on
  another socket (another herdr), no web terminal address is filled in and
  the port is listed as "check".
- A core that did not answer held every collect for 5 seconds. After a
  timeout it is asked with a 1-second wait for the next 30 seconds (back
  to 5 seconds as soon as it answers), and only its own sessions show as
  unreachable.
- A session of a view-only app whose core had stopped answered with an
  error (500) on click. It now says the app is not running.

- Enter jumped to the "next" session even when another session had keyboard
  focus.
- The first screen waited for git branch lookups.
- A new terminal window could open twice when the terminal app was slow to
  start.
- A new Ghostty window did not open when the path to herdr contained a space
  or a quote.
- Resuming the same conversation from two empty sessions at once started it
  twice. The second request is turned away.
- A session closed from the board could come back for a few seconds when a
  collect that had started before the close finished after it. The same
  goes for resume, new session and turning a desk off or on: a collect
  that started before the change is no longer applied after it.
- The last request of a conversation that had just started could stay empty
  for five minutes, because a history file that did not exist yet was
  remembered as missing. It is looked for again after ten seconds.
- Installing wrote `auto.json` to `~/.config/whosup`, a copy the plugin never
  read. Install no longer writes the file; it is written to the state folder
  before every start.

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
