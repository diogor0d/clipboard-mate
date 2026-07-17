# Docker server deployment

Only the Clipboard Mate API belongs on the server. Windows and macOS tray
clients run natively, and the iPhone integration runs in Shortcuts.

## Prerequisites

- Docker Engine with Docker Compose v2
- a backup policy that includes the managed `clipboard-mate-data` Docker volume
- an authenticated HTTPS route to the loopback service (Cloudflare Tunnel is
  the expected deployment)

The Compose service is called `api`. It listens inside the container on port
43120, stores SQLite data under `/data` on a managed volume, and publishes the
port on the server's `127.0.0.1` by default. Do not change the bind address to
`0.0.0.0` merely to make the service internet-accessible.

## Start the service

From the repository root:

```bash
cp .env.example .env
docker compose up -d --build
docker compose ps
curl --fail http://127.0.0.1:43120/health
```

On PowerShell, use `Copy-Item .env.example .env` for the first command.

Review these settings in `.env` before deployment:

| Variable | Default | Meaning |
| --- | --- | --- |
| `CLIPBOARD_MATE_BIND_ADDRESS` | `127.0.0.1` | Host interface receiving the published port |
| `CLIPBOARD_MATE_BIND_PORT` | `43120` | Server loopback port |
| `CLIPBOARD_MATE_HISTORY_LIMIT` | `250` | Unpinned retained revisions |
| `CLIPBOARD_MATE_MAX_TEXT_BYTES` | `262144` | Maximum UTF-8 text size |
| `CLIPBOARD_MATE_ALLOWED_ORIGIN` | empty | Optional browser CORS origin |
| `CLIPBOARD_MATE_IMAGE` | `clipboard-mate-api:local` | Image name/tag built by Compose |

Compose fixes the container listener to `0.0.0.0:43120` and the database path to
`/data/clipboard-mate.sqlite`; those are internal settings, not public exposure.
The named `clipboard-mate-data` volume persists the database across container
replacement. Keep it private: it contains plaintext clipboard history and
authentication metadata.

## Bootstrap one credential per device

Start the API first, then create a separate credential for every app or
Shortcut:

```bash
docker compose exec api node dist/cli/create-device.js --name "Diogo iPhone"
docker compose exec api node dist/cli/create-device.js --name "Windows desktop"
docker compose exec api node dist/cli/create-device.js --name "Mac desktop"
```

Each command displays a device ID and bearer token. The token is printed only
once; enter it into that device immediately and do not put it in `.env`, shell
history, logs, screenshots, or this repository. Save the device ID so the
credential can be revoked later.

To revoke a lost or retired device:

```bash
docker compose exec api node dist/cli/revoke-device.js --id <device-uuid>
```

Revocation takes effect on the device's next request or stream reconnect.

## Cloudflare Tunnel

Run a named Cloudflare Tunnel on the server and map a dedicated hostname to the
loopback origin. A host-installed `cloudflared` ingress entry is conceptually:

```yaml
ingress:
  - hostname: clipboard.example.com
    service: http://localhost:43120
  - service: http_status:404
```

If `cloudflared` itself runs in a container, `localhost` refers to that
container, not the Docker host. Put it on an intentionally designed shared
network and route to the `api` service, or use the platform's supported host
gateway. Do not broadly publish the API port as a workaround.

Configure a Cloudflare Access application for the hostname and require a
service-token policy. Create a different Cloudflare service token where useful
for independent revocation. Requests then carry two layers of credentials:

```text
CF-Access-Client-Id: <access-service-token-id>
CF-Access-Client-Secret: <access-service-token-secret>
Authorization: Bearer <clipboard-mate-device-token>
```

The first two headers pass Cloudflare Access. The bearer token identifies and
authorizes the Clipboard Mate device. Do not place either credential in a URL or
query string. The desktop setup screen accepts the Access ID and secret; add the
same headers explicitly to each iOS Shortcut request.

Use `https://clipboard.example.com` as the client API URL. Remote desktop setup
rejects plain HTTP by design.

## Updates and backups

To update from a reviewed working tree:

```bash
docker compose build --pull
docker compose up -d
docker compose ps
curl --fail http://127.0.0.1:43120/health
```

Back up the complete `clipboard-mate-data` volume while the service is stopped
so the SQLite database and any WAL files form a consistent set:

```bash
docker compose stop api
# snapshot the clipboard-mate-data volume with your encrypted backup tooling
docker compose start api
```

Treat backups as secrets because retained clipboard contents are plaintext.
Do not copy only `clipboard-mate.sqlite` while the API is running; SQLite may
also have active WAL files. Test restoration to a non-production volume
periodically.
