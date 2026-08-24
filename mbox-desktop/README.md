# MBOX Desktop

Electron desktop shell for MBOX.

It opens the real MBOX web app as the primary interface and adds local computer functions:

- start/stop Codex and Claude responder watchers;
- install/remove Windows user autostart for responders;
- tray menu and native application menu;
- floating MBOX Desktop panel injected over the web UI;
- repository shortcut.

## Run

```powershell
cd C:\Users\a.nikolyuk\Desktop\Mbox\memora\memora-graph\mbox-desktop
npm install
npm start
```

The app reads `MBOX_URL` from the environment and falls back to `https://mbox.shar-os.ru`.
