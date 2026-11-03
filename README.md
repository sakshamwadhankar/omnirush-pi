# omnirush-pi

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[Pi](https://pi.dev) provider for **OmniRush** models — `gpt-6-astra`, `gpt-6.1-sol`, and `gpt-6-sol` — powered by your own OmniRush CLI login. No extra login inside Pi, no daemon, no third-party gateways.

The extension reads the credentials the official OmniRush CLI already stores (`~/.omnirush/auth.json`), registers an `omnirush` provider with Pi's built-in OpenAI Responses API implementation, and replicates the official client's wire signature so the gateway accepts the requests.

## What it gives you

| Provider | Model | Context | Output | Reasoning | Images |
|---|---|---|---|---|---|
| `omnirush` | `gpt-6-astra` | 400K | 128K | yes | yes |
| `omnirush` | `gpt-6.1-sol` | 400K | 128K | yes | yes |
| `omnirush` | `gpt-6-sol` | 400K | 128K | yes | yes |

The model list is fetched live from the gateway catalog (`GET <gateway>/models`) with a built-in seed fallback, so newly published models appear without republishing the package.

## Requirements

- **OmniRush CLI installed and signed in once** (`npm install -g omnirush` → run `omnirush` → log in). The extension uses the CLI's existing `~/.omnirush/auth.json`; it never asks for a password and never stores tokens of its own.
- Pi 1.4+ (Node 22+).

## Install

```bash
pi install git:github.com/sakshamwadhankar/omnirush-pi
```

or locally:

```bash
pi install ./omnirush-pi
```

Then `/reload` in Pi (or restart). Pi models will appear under the **OmniRush** provider.

## Usage

- Select e.g. `omnirush/gpt-6-astra` from the model picker.
- Commands:
  - `/omnirush models` — list registered models (refreshes the catalog)
  - `/omnirush refresh` — rotate tokens + refresh models
  - `/omnirush version` — show the CLI version used in the fingerprint

## How it works

The OmniRush gateway (`https://omnirush.ai/omnirush/v1`) only serves the **OpenAI Responses API** (`chat/completions` is not implemented) and only accepts requests that look like the official client. The extension:

1. **Reads `~/.omnirush/auth.json`** (access + refresh token written by the CLI).
2. **Registers the provider** with Pi's native `openai-responses` implementation — Pi already sends the body shape the gateway requires (`input` list, `stream: true`, `store: false`).
3. **Injects the gateway fingerprint per request** via `before_provider_headers`:
   - `User-Agent: omnirush` (bare product label — a versioned `omnirush/x` is refused)
   - `X-OmniRush-Client: cli/<version>`
   - `x-omnirush-session-id: <EID ses_...>`
   - `Authorization: Bearer <access token>`
4. **Rotates tokens automatically**: access tokens expire, so the extension refreshes via `POST /device/refresh` and writes the new pair back atomically (temp file + rename), exactly like the CLI does. A background refresher keeps the token warm; a 401 triggers an immediate refresh for the next request.
5. **Surfaces gateway state honestly**: maintenance/official-client errors pass through as provider errors instead of being hidden.

## Fine print — please read

- **ToS gray zone.** This uses your own CLI credentials outside the official client. OmniRush's gateway enforces its "official client only" policy; using it this way may violate their terms and carries a risk of account suspension. You're responsible for your account.
- **No bypasses.** This package does **not** raise your daily token quota, bypass maintenance, or hide usage. The free tier's limits are enforced server-side per account and cannot be changed from the client. Don't use this to farm accounts or steal/rotate tokens — their anti-sharing detection signs devices out.
- **Maintenance windows.** When the gateway is in maintenance, requests fail with its own banner until service resumes. The extension does not retry or hide this.

## Development

```bash
node --test   # Node 22+ runs the TypeScript tests directly
```

Tests cover the EID session-id shape, header fingerprint building, auth parsing/tolerance, catalog mapping, and Pi model definition generation.

## License

MIT
