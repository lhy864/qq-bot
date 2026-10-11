# Little Whale · QQ Bot

**A local QQ companion built around a persona, continuity, and grounded interests.**

A maintained source export of [qq-bridge](https://github.com/Derpyu520/qq-bridge), connecting SnowLuma / OneBot v11 to DeepSeek Harness (DSH). Upstream attribution and the [MIT license](LICENSE) are preserved.

[中文首页](README.md) · [Architecture](docs/ARCHITECTURE.md) · [Capabilities](docs/FUNCTIONS.md) · [Validation](docs/VALIDATION.md)

## What it includes

| Area | Capability |
| :--- | :--- |
| Conversation | Persona cards, expressive replies, Emoji, QQ faces and saved images |
| Continuity | Identity-based aliases, agreements and topic progress across private and group chats |
| Interests | Simulated anime progress, actual web excerpts, reading notes and learning exercises |
| Management | Local console, allowlists, pause/silence, model settings, usage and diagnostics |

## Try the offline console

Use Node.js 24 and npm:

```powershell
npm ci --ignore-scripts --legacy-peer-deps
node scripts/patch-snowluma-sdk.mjs
npm run preview:console
```

Open the address printed in the terminal. The preview uses synthetic in-memory data and sends no QQ messages. For a real deployment, provide your own QQ, SnowLuma, DSH, allowlist and local configuration; follow the [Chinese setup guide](README.md#快速上手).

<details>
<summary>Offline console preview</summary>

![Local console with synthetic data](docs/assets/console-overview.jpg)

</details>

## Validation and limits

Local isolated engineering tests: **40/40**. Mock console browser checks: **38/38**. The full installed-DSH compatibility suite is **40/41**, with a documented tool-name mismatch. Check repository Actions for actual remote CI results.

Conversation quality and all external API versions are not universally verified. Anime counters are simulated, and available subtitles do not imply visual video understanding. Private-scope memories stay private. Voice and some profile/space actions need separate configuration and verification.

Runtime state, credentials and real conversations are excluded from this source export. See [SECURITY.md](SECURITY.md) before publishing custom configurations or role cards.
