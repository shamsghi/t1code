# t1code

Terminal-first T3 Code fork with an OpenTUI client.

## Install

```bash
bunx @maria_rcks/t1code
```

Requires Bun `>=1.3.9`.

Linux notes:

- T1Code follows XDG defaults on Linux:
  `XDG_CONFIG_HOME/t1code` for prefs, `XDG_STATE_HOME/t1code` for logs and image state, and `XDG_DATA_HOME/t1code` for app data.
- Opening links uses desktop helpers such as `xdg-open` or `gio open`.
- Clipboard image paste works with `wl-paste` on Wayland or `xclip` on X11.

## What You Get

- Native-feeling terminal UI built on OpenTUI
- Bundled server and web client for local use
- Codex-first workflow tuned for terminal usage

## Source

- Repo: https://github.com/maria-rcks/t1code
- Issues: https://github.com/maria-rcks/t1code/issues

Based on T3 Code by `@t3dotgg` and `@juliusmarminge`.
