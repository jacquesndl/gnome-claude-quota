# GNOME extension "Claude Quota": Claude usage in the top bar

> **For Claude (Claude Code): how to use this README.**
> 1. Read "Requirements", then follow "Step-by-step installation" in order.
> 2. The install goes through this repository, cloned to `~/Workspace/src/gnome-claude-quota`, and its `install.sh`. Do not rewrite the code.
> 3. The only change you may make without asking: add the GNOME Shell major version to `shell-version` in `metadata.json`.
> 4. You cannot log the user out or see their top bar. Enable the extension, ask the user to log out and back in (Wayland), then check with `gnome-extensions info` and the journal (step 6).
> 5. Never print the OAuth token and never write it to any file.

Last updated: 2026-10-30. Tested on Ubuntu 26.04, GNOME Shell 50.1, Wayland session.

The extension's UI text and code comments are in French. This README quotes UI strings in French with an English translation.

## What it does

An indicator in the GNOME top bar shows Claude usage, without opening claude.ai:

```
✻ 42% · 17:30
```

- `42%`: share of the current **session** used (5-hour rolling window).
- `17:30`: local time when the session resets. Hidden once the session has already reset.
- `⚠` at the end: the last request failed. The number shown is the last known value.
- Color: default below 75 %, orange (`#ff7800`) from 75 %, bold red (`#e01b24`) from 90 %. Based on the session only.

Clicking it opens a menu with:

- every limit returned by the API (5-hour session, weekly all models, and weekly Opus / Sonnet limits when the API returns them), each with its %, a bar `▰▰▰▱▱▱▱▱▱▱` and the time until reset;
- the time of the last update, or the error message;
- "Actualiser" (refresh);
- "Ouvrir la page d'utilisation" (open https://claude.ai/settings/usage).

GNOME notifications fire when the session or the weekly limit crosses 80 % and then 95 %. One notification per threshold; a threshold re-arms once usage drops back below it.

## Quick install

```bash
git clone git@github.com:jacquesndl/gnome-claude-quota.git ~/Workspace/src/gnome-claude-quota
cd ~/Workspace/src/gnome-claude-quota
./install.sh
# then log out and log back in (Wayland)
```

Uninstall: `./install.sh --remove`. Details in "Step-by-step installation".

## Repository contents

```
claude-quota@jacques.local/   the extension (metadata.json, extension.js)
install.sh                    installs / updates and enables it; --remove uninstalls
LICENSE                       GPL-2.0-or-later
```

## Requirements

- GNOME Shell (Ubuntu 26.04 ships GNOME 50). Check with `gnome-shell --version`.
- **Claude Code installed and logged in with a claude.ai account** (Pro/Max plan, not an API key). Logging in creates `~/.claude/.credentials.json` (or `$CLAUDE_CONFIG_DIR/.credentials.json`), which holds the OAuth token the extension needs.
- Does not work with an API key (`ANTHROPIC_API_KEY`), Bedrock or Vertex: no claude.ai token, no session quota.
- Nothing to install: the extension only uses libraries shipped with GNOME Shell (Soup 3, Gio, GLib, St).

## How it works

### Data source

The extension calls the endpoint used by the `/usage` command in Claude Code:

```
GET https://api.anthropic.com/api/oauth/usage
Authorization: Bearer <accessToken>
anthropic-beta: oauth-2025-04-20
```

**This endpoint is undocumented** and may change without notice. If the extension suddenly stops working, check this first (see "Troubleshooting").

Response seen on 2026-10-30 (excerpt; many other fields are `null`):

```json
{
  "five_hour": { "utilization": 7.0,  "resets_at": "2026-10-30T11:50:00.509107+00:00" },
  "seven_day": { "utilization": 37.0, "resets_at": "2026-11-01T15:00:00.509123+00:00" },
  "seven_day_opus": null,
  "seven_day_sonnet": null,
  "extra_usage": { "is_enabled": false, "...": "..." }
}
```

- `utilization` is already a percentage (0 to 100).
- `resets_at` is an ISO 8601 date in UTC; the extension shows it in local time.

The code handles two formats:

1. a `limits` array (`[{kind, percent, resets_at, scope}]`, with `kind` = `session`, `weekly_all` or `weekly_scoped`) when present. This format was seen at some point;
2. otherwise, the fields `five_hour` (→ session), `seven_day` (→ weekly), `seven_day_opus` and `seven_day_sonnet` (→ weekly per model, when not `null`). **This is the format the API returns today.**

A limit whose `resets_at` is in the past is shown as 0 %.

### Authentication

- The token is read from `.credentials.json` (key `claudeAiOauth.accessToken`) **on every request**. Folder: `$CLAUDE_CONFIG_DIR` if set, otherwise `~/.claude`.
- **`CLAUDE_CONFIG_DIR` gotcha**: GNOME Shell must see the variable, not just the terminal. An `export` in `~/.zshrc` or `~/.bashrc` is not enough. Put it in `~/.config/environment.d/claude.conf` (line `CLAUDE_CONFIG_DIR=/absolute/path`), then log out and back in.
- The tracked account is the one Claude Code is logged in with. To switch: `claude`, `/logout`, `/login`. The extension has no setting for this.
- A 401 or 403 response is treated as an expired or rejected token.
- Claude Code refreshes the token when it expires. The extension only reads the file: it never writes to it and never refreshes anything itself. So if Claude Code has not run for a while, the token expires and the indicator shows `✻ ⚠` with "Token expiré : lance Claude Code pour le rafraîchir" (token expired: run Claude Code to refresh it). Running `claude` once fixes it.
- The token is only sent to `api.anthropic.com`.

### Refresh cycle

- One request when the extension starts, then every 180 s (`POLL_SECONDS`).
- One request when the menu opens, unless the last one is less than 30 s old (`MENU_REFRESH_MIN_MS`): the API returns 429 (too many requests) when called too often.
- One request at a time (`_busy`); 15 s HTTP timeout.

### Settings (constants at the top of `extension.js`)

| Constant | Value | Purpose |
|---|---|---|
| `POLL_SECONDS` | `180` | interval between two requests |
| `MENU_REFRESH_MIN_MS` | `30000` | minimum delay between two requests triggered by opening the menu |
| `WARN` / `CRIT` | `75` / `90` | orange / red color thresholds |
| `NOTIFY_THRESHOLDS` | `[80, 95]` | notification thresholds |
| `NOTIFY_KINDS` | `['session', 'weekly_all']` | limits that trigger notifications |

### Files installed

```
~/.local/share/gnome-shell/extensions/claude-quota@jacques.local/
├── metadata.json   # extension identity, supported GNOME versions
└── extension.js    # all the code (ES module, GNOME 45+ extension API)
```

The UUID `claude-quota@jacques.local` must exactly match the folder name and the `uuid` field in `metadata.json`.

## Step-by-step installation

1. **Check the requirements.**

   ```bash
   gnome-shell --version                                   # e.g. "GNOME Shell 50.1"
   echo $XDG_SESSION_TYPE                                  # wayland or x11
   test -f "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.credentials.json" && echo "Claude Code logged in"
   ```

   If the credentials file is missing, run `claude`, then `/login` with the claude.ai account.

2. **Test the API before installing** (without printing the token):

   ```bash
   T=$(python3 -c "import json,os;d=os.environ.get('CLAUDE_CONFIG_DIR') or os.path.expanduser('~/.claude');print(json.load(open(d+'/.credentials.json'))['claudeAiOauth']['accessToken'])")
   curl -s -H "Authorization: Bearer $T" -H "anthropic-beta: oauth-2025-04-20" \
     https://api.anthropic.com/api/oauth/usage | python3 -m json.tool | head -20
   ```

   You should see `five_hour` and `seven_day` with `utilization` and `resets_at`. If the format has changed, update `parseLimits()` in `extension.js` before going further.

3. **Get the repository and install.** Private repository: needs an SSH key allowed on the `jacquesndl` GitHub account, or collaborator access.

   ```bash
   if [ -d ~/Workspace/src/gnome-claude-quota/.git ]; then
     git -C ~/Workspace/src/gnome-claude-quota pull --ff-only
   else
     mkdir -p ~/Workspace/src
     git clone git@github.com:jacquesndl/gnome-claude-quota.git ~/Workspace/src/gnome-claude-quota
   fi
   cd ~/Workspace/src/gnome-claude-quota && ./install.sh
   ```

   `install.sh` copies `extension.js` and `metadata.json` to `~/.local/share/gnome-shell/extensions/claude-quota@jacques.local/`, enables the extension, and warns if the GNOME version is not in `shell-version` or if Claude Code is not logged in. It needs no `sudo`. The same script handles updates.

   If the GNOME Shell major version is not in `shell-version` of `claude-quota@jacques.local/metadata.json`, add it and rerun `./install.sh`.

4. **Enable the extension.**

   ```bash
   gnome-extensions enable claude-quota@jacques.local
   ```

   If GNOME does not know the extension yet, this command may fail. In that case, add it to the list of enabled extensions directly:

   ```bash
   python3 - <<'PY'
   import ast, subprocess
   uuid = 'claude-quota@jacques.local'
   cur = ast.literal_eval(subprocess.check_output(['gsettings', 'get', 'org.gnome.shell', 'enabled-extensions'], text=True).replace('@as ', ''))
   if uuid not in cur:
       subprocess.run(['gsettings', 'set', 'org.gnome.shell', 'enabled-extensions', str(cur + [uuid])], check=True)
   PY
   ```

   Also check that user extensions are not all disabled: `gsettings get org.gnome.shell disable-user-extensions` must return `false`.

5. **Make GNOME load the extension** (the user must do this).
   - **Wayland** (Ubuntu default): GNOME Shell does not load a new or changed extension without a restart. **The user must log out and log back in.** Disabling and re-enabling the extension does not reload the code.
   - **X11**: `Alt+F2`, type `r`, Enter.

6. **Check after logging back in.**

   ```bash
   gnome-extensions info claude-quota@jacques.local          # expect "State: ACTIVE" ("État: ACTIVE" on a French system)
   journalctl /usr/bin/gnome-shell -b --no-pager | grep -i -A5 claude-quota | tail -20   # expect no errors
   ```

   Ask the user whether they see `✻ xx% · HH:MM` in the top bar, and whether clicking it shows the detailed limits. With `State: ERROR` or a JavaScript error in the journal (for example after a major GNOME update that changed an API), see "Troubleshooting".

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Nothing in the top bar | extension not detected or not enabled | `gnome-extensions info claude-quota@jacques.local`; log out and back in (Wayland); check that `shell-version` contains the current version |
| `State: ERROR` | JavaScript error | `journalctl /usr/bin/gnome-shell -b \| grep -i -A5 claude` |
| `✻ ⚠`, "Token expiré" or "Token refusé" (expired / rejected) | OAuth token expired | run `claude` once so it refreshes the token |
| `✻ ⚠`, "…/.credentials.json illisible" (unreadable) | Claude Code not logged in, or wrong folder | `claude` then `/login`; if `CLAUDE_CONFIG_DIR` is used, check it is set in `~/.config/environment.d/` |
| `✻ ⚠`, "Erreur HTTP 429" | too many requests | wait; do not lower `POLL_SECONDS` or `MENU_REFRESH_MIN_MS` |
| `✻ ⚠`, "Erreur HTTP 4xx/5xx" | endpoint changed or down | rerun the `curl` test from step 2; update the URL, headers or `parseLimits()` |
| `✻ …` forever | both response formats are gone | rerun the `curl` test and adapt `parseLimits()` to the new format |
| A code change has no effect | module cache on Wayland | log out and back in |

To test a change without logging out (Wayland), run a nested GNOME Shell: `dbus-run-session -- gnome-shell --devkit` (GNOME 49+, may need the `mutter-dev-bin` package) or `dbus-run-session -- gnome-shell --nested --wayland` on older versions.

## Uninstall

```bash
gnome-extensions disable claude-quota@jacques.local
rm -rf ~/.local/share/gnome-shell/extensions/claude-quota@jacques.local
```

Or `./install.sh --remove`. Then log out and back in to remove the indicator.

## History

- 2026-10-30: created (top bar: `session% · weekly%`).
- 2026-10-30: top bar shows `session% · reset time`; weekly moves to the menu; color depends on the session only.
- 2026-10-30: `CLAUDE_CONFIG_DIR` support, weekly Opus / Sonnet limits, 403 treated as a rejected token, at most one request every 30 s when opening the menu.
- 2026-10-30: full English documentation in this README.

## License

GPL-2.0-or-later, see `LICENSE`.
