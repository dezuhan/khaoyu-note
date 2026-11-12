# Public sharing over the internet

Khaoyu Note can put a public origin into its share links, but the host must actually be reachable
from the internet. The application cannot create that route through NAT, a firewall or a CGNAT
connection by itself.

## Option 1: public IP with port forwarding

1. Put the service on the network interface that receives traffic:
   `KHAOYU_SERVICE_HOST=0.0.0.0`.
2. Choose a port such as `8080` and allow it in the host firewall.
3. Add a router port-forward from the public IP to this host and port.
4. Set the public origin used in links, for example:
   - `KHAOYU_SERVICE_PUBLIC_URL=http://203.0.113.10:8080`
   - `KHAOYU_SERVICE_SHARE_PUBLIC_URL=http://203.0.113.10:8080`
5. In **Settings > Server > Public share links**, enter the same origin and save.

Use a dynamic DNS name if the public IP changes. Plain HTTP exposes passwords and share tokens;
HTTPS is strongly recommended.

## Option 2: reverse proxy + domain (recommended)

Run Caddy, nginx or another TLS proxy in front of the service and use a domain:

```env
KHAOYU_SERVICE_HOST=127.0.0.1
KHAOYU_SERVICE_PUBLIC_URL=https://notes.example.com
KHAOYU_SERVICE_SHARE_PUBLIC_URL=https://notes.example.com
KHAOYU_SERVICE_COOKIE_SECURE=true
KHAOYU_SERVICE_TRUST_PROXY=true
```

The proxy should forward the frontend port and preserve `Host`, `X-Forwarded-For` and
`X-Forwarded-Proto`. Open only the proxy port (443), not the internal service ports.

## Option 3: tunnel for CGNAT or no port forwarding

Use a tunnel such as Cloudflare Tunnel, ngrok or Tailscale Funnel and point it at the frontend
port. Set both public URL variables and the **Public share links** field to the tunnel HTTPS origin.
Free tunnel hostnames change unless you configure a stable domain.

## Where the public URL is used

- `POST /projects/:id/shares` and share rotation return an absolute `url` built from
  `KHAOYU_SERVICE_SHARE_PUBLIC_URL`.
- The desktop client uses **Settings > Server > Public share links** first, then the server-returned
  URL, then the sync server URL.
- The browser board link uses the saved public share origin as well. The native desktop window
  still cannot serve its local `?board=` link to other devices; use a service share link, or run the
  web host and expose that origin.

## Two public hostnames

The team installer accepts two origins:

- `KHAOYU_SERVICE_PUBLIC_URL` — backend/admin origin, for example `https://note.example.com`;
- `KHAOYU_SERVICE_SHARE_PUBLIC_URL` — public share-view origin, for example
  `https://view.example.com`.

The backend/admin domain points at the service frontend `18080`; the public-view domain points at
the **main board frontend** (the web host, default port `1430`):

```text
admin.example.com -> http://127.0.0.1:18080   login, admin, API
note.example.com  -> http://127.0.0.1:1430    workspace, boards, public share
```

Set `KHAOYU_SERVICE_MAIN_APP_URL=https://note.example.com` on the service. Generated share links then
open the main frontend as `/?share=<token>&server=<service-origin>` instead of the legacy `/s` page.

## Troubleshooting the public port

If a public IP URL does not open:

1. Check the listener, not just the URL:
   `ss -ltnp | grep -E ':8080|:18080|:443'`.
2. A listener bound to `127.0.0.1` is reachable only on this machine. Bind the service/proxy to
   `0.0.0.0` or terminate TLS on a reverse proxy.
3. Confirm the router forwards the public port to this host and that the host firewall allows it.
4. Test from another network; a request from the same machine may succeed through NAT hairpinning even
   when the public route is broken.
5. Put the public origin in both `KHAOYU_SERVICE_PUBLIC_URL` and
   `KHAOYU_SERVICE_SHARE_PUBLIC_URL` (or the app's Public share links setting), then restart.
6. Prefer a TLS reverse proxy or tunnel. Do not expose the backend API port directly.

The development proxy on `8080` and the service listeners on `18080/18081` are loopback-only by
default; the local app host on `1430` is not the public service share origin.

## Checklist

- [ ] Service reachable from outside on the chosen HTTPS origin.
- [ ] `KHAOYU_SERVICE_PUBLIC_URL` and `KHAOYU_SERVICE_SHARE_PUBLIC_URL` both set.
- [ ] Public share URL saved in the app.
- [ ] HTTPS certificate valid; cookies Secure.
- [ ] Firewall exposes only 443, not admin/internal ports.
- [ ] Share links tested from a different network, not just localhost.
- [ ] Revoke unused links from **Active links**.

## Security notes

Share links are bearer secrets. Anyone with the link can open the selected scope until it expires or
is revoked. Use passwords, expiry, download limits and the public-sharing kill switch for sensitive
boards. Do not expose the service admin panel or database port directly to the internet.
