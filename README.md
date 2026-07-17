# Clipboard Mate

Clipboard Mate is a deliberately manual shared clipboard for iPhone, Windows,
and macOS. The server keeps one current text value plus revision history. Native
desktop clients keep that shared state ready in a tray popover, but they never
monitor, upload, or overwrite the operating-system clipboard in the background.

## What it does

- **Copy shared** writes the already-cached shared value to the local clipboard.
- **Publish local clipboard** reads and uploads the local clipboard only when
  clicked.
- **Publish text** uploads the popover's text without touching the local
  clipboard.
- **Edit current** replaces the shared value with revision-conflict protection.
- The API state stays fresh through server-sent events with periodic refresh as
  a fallback.
- Maccy and Windows Clipboard History remain the local history managers.

The important boundary is that background synchronization means **API state to
the app's encrypted cache**, not OS clipboard synchronization. The only code
paths allowed to read or write the clipboard are explicit user actions.

## Components

| Component | Runs on | Responsibility |
| --- | --- | --- |
| API | Docker on your server | Authenticated current state, SQLite history, revision events |
| Desktop app | Native Electron app on Windows/macOS | Tray popover, encrypted local cache, explicit clipboard actions |
| iOS Shortcuts | iPhone/iPad | Explicit publish and pull actions |

See [Architecture](docs/architecture.md), [server deployment](docs/deployment.md),
[desktop builds](docs/desktop.md), and [iOS Shortcut setup](docs/ios-shortcuts.md)
for the full design.

## Run the API with Docker Compose

The production API is intended to run in Docker. It binds to loopback by
default; publish it through an authenticated HTTPS reverse proxy such as
Cloudflare Tunnel instead of exposing port 43120 directly.

```powershell
Copy-Item .env.example .env
docker compose up -d --build
docker compose exec api node dist/cli/create-device.js --name "Diogo iPhone"
```

The last command prints a device ID and a token once. Create a separate token
for each desktop client and Shortcut, then store each token in that client.
Detailed deployment, Cloudflare Access, backup, and revocation instructions are
in [docs/deployment.md](docs/deployment.md).

## Local development

Prerequisites: Node.js 22+ and pnpm 11.

```powershell
Copy-Item .env.example .env
pnpm install
pnpm device:create -- --name "Windows development"
pnpm dev:api
```

In another terminal:

```powershell
pnpm dev:desktop
```

Enter `http://127.0.0.1:43120` and the development device token in the desktop
client. Plain HTTP is accepted only for loopback development; use HTTPS for a
remote API.

Useful checks:

```powershell
pnpm typecheck
pnpm test
pnpm build
```

Create an unpacked desktop build with
`pnpm --filter @clipboard-mate/desktop package:dir`. Windows and macOS artifact
commands, plus signing boundaries, are documented in
[docs/desktop.md](docs/desktop.md).

## Security boundaries

- Device tokens are random, independently revocable credentials. Only token
  hashes are stored by the API.
- Electron keeps credentials and the cached shared value in OS-backed encrypted
  storage; credentials are never exposed to the renderer.
- API responses are `no-store`, request bodies are not logged, and text size is
  capped (256 KiB by default).
- The API and its SQLite history can read the shared plaintext. End-to-end
  encryption is not currently implemented.
- A Shortcut containing credentials is a secret-bearing artifact. Do not share
  or export it with real tokens embedded.

Clipboard Mate is currently text-only and designed for one trusted user's
devices.
