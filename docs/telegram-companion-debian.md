# Shared Telegram companion on Debian

One operator runs one bot for multiple users. Users pair their vault with the
bot; they do not create a bot or enter the operator's bot token. The companion
is a separate service, not part of Obsidian startup.

## Guided first installation

The server package includes `install.py` and a Russian quick guide,
`START-HERE-ru.md`. On a fresh Debian 12+ x64/ARM64 host, extract the complete
package, open a terminal in that directory and run `sudo python3 install.py`.
The wizard asks for the public IPv4 and a hidden bot token, shows its plan,
and requests confirmation before installation. It prepares its own dependencies,
private configuration, nginx/IP HTTPS, certificate renewal and systemd startup.
Existing installations and conflicting sites are preserved and require manual
review. Port forwarding and laptop sleep settings remain operator prerequisites.
The detailed manual procedure below remains available for updates and recovery.

The service stores the explicitly exported questions/answers, pairing secrets
and pending results outside the vault. Its state is private but unencrypted.
Protect the server disk and backups. Obsidian remains the authority for Core
history and schedules; a Telegram result is pending until desktop import and
acknowledgement. Closing Obsidian also stops fresh desktop uploads/imports.

Exact-answer cards use the same deterministic text/literal matching rules as
the desktop. The learner replies to the specific question message, then chooses
a recall rating; a matching string is not itself a Core review grade.
Hints and physical image/audio/video attachments require a separate saved
desktop opt-in. Existing connections retain their previous text-only permission.
Uploads use the signed `/bridge/snapshot` route, so no new proxy route is needed.
Local paths and original filenames are not sent. Bounded recording clips must
first be saved as separate files; the complete source recording is not exported.

Private media live beneath `stateDirectory/media/<enrollment>` and are included
in the updater's protected state backup. Each file is limited to 50 MB (decimal
bytes); there is no default aggregate byte or file-count quota per account or
service. Available disk space and memory still matter. There is no automatic
cache deletion; preserve the state when diagnosing storage or integrity failures.
Do not manually remove media while the service is running. A failed or uncertain
Telegram media delivery blocks the dependent question/rating controls and is not
automatically retried; the learner can start a fresh attempt with `/go`.

## Check the server first

Read the Debian version and CPU architecture before choosing installation packages:

```sh
cat /etc/os-release
uname -m
```

Use a supported **Node.js 24 LTS** build for that architecture from the
[official Node.js downloads](https://nodejs.org/en/download), verifying its
signed checksums. Do not assume Debian's default `nodejs` package is version 24.
The service uses `/usr/bin/node`; update `ExecStart` if your installation uses
a different absolute path. Confirm it with `node --version`.

## Build once, deploy without npm

On the development machine, with the repository dependencies installed:

```sh
npm ci
npm run build
node dist/telegram-companion/anchor-recall-companion.cjs --help
```

`dist/telegram-companion/` contains the standalone
`anchor-recall-companion.cjs`, service unit, disabled configuration example,
installation guide, license/notices, artifact metadata and `SHA256SUMS`.
Copy this directory to the Debian server. Do not copy a vault, `data.json`,
developer credentials or `node_modules`. The server needs **Node.js >=24**;
it does not need npm, pnpm, TypeScript or esbuild. Verify the installed binary
with `/usr/bin/node --version`; adjust the unit if Node lives elsewhere.

## Private service user and files

Run these commands as an administrator from the copied artifact directory.
Create the account only if it does not already exist:

```sh
sudo useradd --system --home-dir /var/lib/anchor-recall-companion --no-create-home --shell /usr/sbin/nologin anchor-recall
sha256sum --check SHA256SUMS
sudo install -d -m 0755 -o root -g root /opt/anchor-recall-companion
sudo install -m 0644 anchor-recall-companion.cjs LICENSE THIRD_PARTY_NOTICES.md /opt/anchor-recall-companion/
sudo install -d -m 0700 -o anchor-recall -g anchor-recall /etc/anchor-recall-companion /var/lib/anchor-recall-companion
sudo install -m 0600 -o anchor-recall -g anchor-recall config.example.json /etc/anchor-recall-companion/config.json
sudoedit /etc/anchor-recall-companion/config.json
```

Replace `botUsername` and `botToken` with your bot's values, then set
`enabled:true`. The example is intentionally disabled and contains no usable
credentials. Keep the token out of shell arguments, screenshots, logs and the
plugin. Configure `stateDirectory` as `/var/lib/anchor-recall-companion`,
`host` as `127.0.0.1`, and `port` as `8787`. `sessionsLocal` contains minutes
after midnight, for example 540=09:00 and 1140=19:00 in each paired vault's
explicit time zone. Account/pairing caps bound storage; they are not a tested
concurrent-user capacity promise. The unit allows 4,096 open descriptors for
the default 1,000-account cap; lower the cap if your host has a lower limit.

The state directory must be mode `0700`, the configuration file `0600`, and
both must be accessible to `anchor-recall`. The service has a restrictive umask
and runs as this non-root user. Its writable state directory is managed by
systemd; see [systemd.exec](https://manpages.debian.org/bookworm/systemd/systemd.exec.5.en.html).

## Existing reverse proxy

If Docker Caddy or another existing proxy already owns ports 80/443, install
only the backend instead of starting a competing nginx:

```sh
sudo python3 install.py --existing-proxy --bind-address 172.18.0.1
```

Replace the example address with the **verified host-side Docker bridge
gateway**, reachable from your proxy's network. This mode accepts RFC1918 IPv4
addresses only and checks that the address is local and TCP 8787 is available.
It provisions Node, the private account/configuration/state, and the companion
systemd service. It does not change the proxy, install nginx/Certbot, request
certificates or create a renewal timer. Existing companion data remains protected.
The normal installer remains the loopback/nginx option for a fresh host.

Forward these six **POST** paths through your existing HTTPS proxy to the
private listener, preserving the exact path, body and `X-Anchor-Signature`:
`/pair/start`, `/pair/status`, `/pair/confirm`, `/bridge/snapshot`,
`/bridge/pending`, `/bridge/ack`. Preserve the existing application's routes
as the fallback; do not strip a prefix. Do not publish TCP 8787 to the internet.
Complete and verify public HTTPS before pairing Obsidian.

The optional study Mini App additionally needs **GET and POST `/miniapp/*`**
forwarded to the same private listener without prefix rewriting. Configure its
public HTTPS URL with the packaged `enable-miniapp.py` helper; see `MINIAPP-ru.md`.
This does not change the existing signed bridge routes or expose port 8787.

For Caddy **2.11.2**, an explicit ACME issuer with `profile shortlived` can
obtain a public-IP certificate. IP clients may omit SNI; a Docker-hosted
listener needs the correct `default_sni`. If the existing site is an HTTP-only
`:80` catchall, `auto_https disable_redirects` preserves its HTTP behavior
while certificate automation remains enabled. Merge these options into the
existing configuration; do not replace another site's TLS policy blindly.
See Caddy's [TLS directive](https://caddyserver.com/docs/caddyfile/directives/tls)
and [global options](https://caddyserver.com/docs/caddyfile/options).

Validate the complete candidate with the **running container's Caddy binary
and environment** before applying it. Back up the original file, then use a
graceful `caddy reload`; preserve `/data` and `/config` so certificate renewal
continues. A single-file Docker bind mount must be updated in place, since
atomic replacement on the host can leave the container reading the old inode.
Retain the integration when deploying future updates of the existing application.

## Public HTTPS with your dedicated IP

A domain is optional: the plugin can use `https://YOUR_PUBLIC_IP` with a
publicly trusted IP certificate. The following route uses nginx and Certbot.
Every `203.0.113.10` below is a documentation placeholder: replace it with your
actual dedicated public IPv4. Forward the router's public TCP ports **80 and
443** to nginx on this Debian host and allow them in its firewall. Test access
from outside the LAN; the desktop must also reach this address from its own
network (some routers need NAT loopback for this).

The Node listener stays on `127.0.0.1:8787`. The proxy must forward
the exact request path/body and `X-Anchor-Signature` header without a path
prefix or rewriting signed bridge requests. Do not expose port 8787 directly.

Install nginx and **Certbot >=5.4** using an installation method suitable for
the checked Debian release and the [official Certbot installer guidance](https://certbot.eff.org/instructions);
run `nginx -v` and `certbot --version` to verify.
Let’s Encrypt supports public IP certificates with the `shortlived` profile
(**six days**); IP webroot support needs Certbot 5.4+. The nginx installer
plugin is not the documented IP route: obtain the certificate with webroot,
then configure nginx explicitly. See the
[official IP certificate instructions](https://letsencrypt.org/2026/03/11/shorter-certs-certbot).

Create `/var/www/letsencrypt` and an enabled nginx site containing this HTTP
server. Keep other sites intact; resolve conflicting listeners/site names
before reloading. The challenge directory must remain reachable on port 80:

```nginx
server {
    listen 80;
    server_name 203.0.113.10;
    location ^~ /.well-known/acme-challenge/ {
        root /var/www/letsencrypt;
    }
    location / { return 404; }
}
```

```sh
sudo install -d -m 0755 /var/www/letsencrypt
sudo nginx -t
sudo systemctl reload nginx
sudo certbot certonly --staging --cert-name anchor-recall-ip-staging --preferred-profile shortlived --webroot --webroot-path /var/www/letsencrypt --ip-address 203.0.113.10
sudo certbot certonly --cert-name anchor-recall-ip --preferred-profile shortlived --webroot --webroot-path /var/www/letsencrypt --ip-address 203.0.113.10
```

The first issuance tests reachability with an **untrusted** staging certificate;
only the second creates the certificate to serve. Add this server to the same
nginx site **after** successful production issuance, then run `sudo nginx -t`
and `sudo systemctl reload nginx`:

```nginx
server {
    listen 443 ssl default_server;
    server_name 203.0.113.10;
    ssl_certificate /etc/letsencrypt/live/anchor-recall-ip/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/anchor-recall-ip/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    client_max_body_size 512000;
    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Anchor-Signature $http_x_anchor_signature;
    }
}
```

The IP TLS site is the default for this 443 listener because IP clients can
omit SNI. There must be exactly one default for that address/port; resolve an
existing default deliberately, preserving its other sites and certificates.
`proxy_pass` has no trailing URI, preserving the signed path; nginx forwards
the request body without rewriting it. TLS file permissions must allow nginx's
master process to read the private key. See nginx's
[HTTPS configuration](https://nginx.org/en/docs/http/configuring_https_servers.html)
and [proxy forwarding](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_pass).

Automatic renewal is essential for a six-day certificate. Install a root-owned
executable deploy hook at
`/etc/letsencrypt/renewal-hooks/deploy/anchor-recall-nginx` containing:

```sh
#!/bin/sh
set -eu
nginx -t
systemctl reload nginx
```

Give the hook mode `0755`. Confirm one active timer/cron job invokes the
installed Certbot's absolute path with `renew` at least twice daily;
configure one if your installation did not provide it. Inspect
`systemctl list-timers --all` and the installation's cron configuration rather
than assuming renewal exists. Test renewal **and** the nginx reload hook:

```sh
sudo certbot renew --cert-name anchor-recall-ip --dry-run --run-deploy-hooks
```

Keep port 80 forwarded for renewal, monitor failures/expiry, and never use a
staging certificate or disabled TLS verification in the plugin. Certbot's
[renewal guide](https://eff-certbot.readthedocs.io/en/stable/using.html#renewing-certificates)
documents hooks and dry runs. These commands are a deployment recipe, not a
claim that this server's certificate, forwarding or renewal has been tested.

### Domain alternative

If you later use a domain, point its DNS at this public IP and use that HTTPS
base URL instead. Caddy can obtain/renew public certificates for a qualifying
DNS name and proxy to the same loopback service. Its default **bare-IP** HTTPS
uses its local CA, so a simple IP-only Caddyfile does not establish public trust.
See [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https).

The bot uses outbound HTTPS long polling to `api.telegram.org`; Telegram does
not need an inbound webhook. **The Obsidian plugin still makes inbound HTTPS
requests to this server**, so outbound polling does not remove the need for
the public plugin endpoint. Allow the server's outbound HTTPS/DNS and the
proxy's inbound HTTPS. Use only one poller for this token. A pre-existing
Telegram webhook must be removed explicitly by the operator before polling;
the service does not delete it or discard pending updates automatically.
Startup checks the bot identity and existing webhook before polling; a wrong
bot identity, active webhook or another poller is a configuration error.
Outgoing delivery is paced across the shared bot and each private chat;
large batches can arrive later rather than being sent as an unrestricted burst.
See Telegram's [getUpdates](https://core.telegram.org/bots/api#getupdates) and
[deleteWebhook](https://core.telegram.org/bots/api#deletewebhook) contracts.

## Validate and start

```sh
sudo -u anchor-recall /usr/bin/node /opt/anchor-recall-companion/anchor-recall-companion.cjs --check --config /etc/anchor-recall-companion/config.json
sudo install -m 0644 anchor-recall-companion.service /etc/systemd/system/anchor-recall-companion.service
sudo systemd-analyze verify /etc/systemd/system/anchor-recall-companion.service
sudo systemctl daemon-reload
sudo systemctl enable --now anchor-recall-companion
sudo systemctl status --no-pager anchor-recall-companion
sudo journalctl -u anchor-recall-companion --since today
```

`--help` and no arguments are inert. `--check` validates the private config
offline: it creates no state or listener and does not verify a token, TLS,
reachability or real Telegram delivery. Startup after `--config` is the
explicit network-enabled action. The service's logs omit secrets and content.

Each user opens Telegram integration in Anchor Recall, enters the operator's
HTTPS address and bot username, and starts pairing. They open the short-lived
bot link in their private Telegram chat and confirm the resulting identity
back in the plugin. The service creates separate account state and secrets;
no user's chat ID, scope, epoch or bridge secret is put in the shared operator
configuration. Export only the cards the user explicitly selects.

## Restart, updates and recovery

Use `sudo systemctl restart anchor-recall-companion`. The unit invokes the
standalone Node process directly and has no duplicate `ExecStop` kill command.
SIGTERM aborts polling, stops new HTTP/timer work and drains current operations
before closing private journals. systemd waits up to 45 seconds; restart policy
and shutdown behavior are described in
[systemd.service](https://manpages.debian.org/bookworm/systemd/systemd.service.5.en.html).

For an existing native installation, extract the complete new server package
into a separate directory and run its updater there:

```sh
sudo python3 update.py --check
sudo python3 update.py
```

`--help` is inert. `--check` verifies package checksums and runs the candidate
offline validator as the service account using the installed Node executable;
it does not stop the service or start another listener/poller. It does not
prove Telegram connectivity or live journal compatibility.

The update command stops **only** `anchor-recall-companion`, waits for shutdown,
and backs up the complete private configuration, state tree and old release
under a root-only directory in `/var/backups`. This includes pending answers,
archived journals and pairing identity. It refuses journal locks instead of
stealing them. Only the bundle, `LICENSE` and `THIRD_PARTY_NOTICES.md` are
replaced. Node, systemd units, configuration, journals, Docker/Caddy, nginx and
VPN settings remain under their existing owners. The readiness check requires
an active service and a local invalid-payload HTTP 400; it does not send a
pairing request or verify real Telegram delivery.

Update the server **before** deploying the matching new Obsidian plugin, then
explicitly synchronize the selected materials. In exact-answer mode, typed
answers pass through Telegram and the configured service; pending responses
and protected backups can contain that text. No automatic deletion deadline
is promised by this update.

On failure, the updater leaves the service stopped. It restores old program
files only when the protected state is byte-for-byte unchanged. Only assets
replaced by this updater qualify, and their current bytes must still match
its release; concurrent operator edits are preserved instead of overwritten.
If a new
runtime has advanced a journal, both the new state and private backup are
preserved for review: do not blindly start an older strict validator, combine
partial journals, or replace current state with a backup that omits newer
answers. Reconcile pending responses before a coordinated manual rollback.
A hard kill may leave an exclusive lock; confirm no instance is alive before
inspecting recovery. Unconfirmed Telegram sends are not blindly resent.

Archived accounts and their private journals retain recovery evidence and
pending results. They count toward the account cap; no automatic account,
receipt or pending-result retention cleanup is promised. Monitor state usage
and reconcile/export retained work before operator-led rotation.

The earlier single-owner server and its journals are not automatically migrated
to this shared service. Keep that state for reconciliation and use explicit
new pairing. Do not run both servers with the same bot token.

The repository supplies the artifact and deployment recipe. It does not mean
that a public endpoint, Debian installation, real bot/account pairing,
cross-user isolation or restart recovery has been accepted in production.
Keep the source-available project's included `LICENSE` and
`THIRD_PARTY_NOTICES.md` with every distribution.
