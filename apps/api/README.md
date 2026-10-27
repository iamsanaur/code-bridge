# codebridge-relay

Your own CodeBridge relay. It connects the CodeBridge phone app to the computers running
[`codebridge-agent`](https://www.npmjs.com/package/codebridge-agent). There is no account and no
password: your phone and your computers join by scanning a QR code that carries a random secret.
Everything (database included) runs in one process on a machine you control.

## Quick start (free, on your own computer)

```bash
npx codebridge-relay start --tunnel cloudflare
```

It prints a QR code. Scan it in the CodeBridge app. On each computer you want to control:

```bash
npm install -g codebridge-agent
codebridge-agent connect '<the link shown under the QR code>'
codebridge-agent workspace add <project folder>
codebridge-agent service install
```

`--tunnel cloudflare` uses a free Cloudflare quick tunnel (install `cloudflared` first). Its address changes
every time the relay restarts, so re-scan the QR code after a restart. Use Fly.io below for a permanent address.

## Permanent address on your own Fly.io account

```bash
npx codebridge-relay fly
```

Needs [`flyctl`](https://fly.io/docs/flyctl/install/). It creates an app, a 1 GB volume and the owner secret in
your account and deploys the published image (about $2/month). Nothing is hosted by anyone else.

Other hosts: [`render.yaml`](../../render.yaml) (a persistent disk needs a paid Render plan) and
[`railway.json`](../../railway.json), or any Docker host:

```bash
docker run -d -p 8080:8080 -v relay-data:/data \
  -e PUBLIC_URL=https://relay.example.com -e OWNER_SECRET=$(openssl rand -base64 33) \
  ghcr.io/iamsanaur/codebridge-relay:latest
```

On a host you set up by hand, find your link with `codebridge-relay link`, or build it yourself:
`codebridge://connect?server=<https url>&secret=<OWNER_SECRET>`.

## Commands

| Command                                                                                   | What it does                                                                 |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `codebridge-relay start [--tunnel cloudflare] [--port N] [--data DIR] [--public-url URL]` | Run a personal relay and print the QR code                                   |
| `codebridge-relay fly [--app NAME] [--region R]`                                          | Deploy to your Fly.io account                                                |
| `codebridge-relay link`                                                                   | Show the QR code and agent command again                                     |
| `codebridge-relay serve`                                                                  | Environment-only startup, for a shared multi-user relay (`RELAY_MODE=multi`) |

Data lives in `~/.codebridge-relay` (or `DATA_DIR`): the embedded database, the owner secret and a key.

## Security

- The connect link contains the owner secret, which gives full control of every computer on the relay. Don't share
  it or post a screenshot. To rotate it, change `OWNER_SECRET` (or delete `owner-secret`) and restart.
- Traffic is encrypted in transit with TLS, but the relay can see terminal traffic while forwarding it. It's your
  relay, so that is you.
- The phone checks that an address is a CodeBridge relay before sending the secret, and asks you to confirm the
  relay when a link is opened.

## License

MIT
