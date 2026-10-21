# Storefront

A self-hosted Discord bot that checks your own Valorant shop and DMs you when a skin on your wishlist shows up.
It replaces [SkinPeek](https://github.com/giorgi-o/SkinPeek), which was archived in June 2025.

- `/shop`: your daily skin shop
- `/accessories`: the accessory store (Kingdom Credits)
- `/nightmarket`: the night market, when it's open
- `/bundle`: the featured bundle(s)
- `/wishlist add|remove|list`: skins to alert on (with autocomplete)
- `/status`: Riot auth status and the next reset times

It's **user-installable**, so the commands work from your account in any server, DM or group DM.
It's **single-user**: only `OWNER_ID` can use it, and it only ever sees your own Riot session.
Your cookie goes to Riot and nowhere else. The only other outside service is valorant-api.com, which provides item names and icons and gets no credentials.

> ⚠️ This uses Valorant's **unofficial** client API, not Riot's official developer API.
> That's a ToS gray area. Read-only store checks aren't known to get accounts banned, but there's no guarantee.
> Endpoints can also break after a patch.

## How it works

1. **Reauth with the `ssid` cookie.** `GET auth.riotgames.com/authorize?...` returns a redirect, and the `access_token` is in the URL fragment.
   If it redirects to the login page instead, the cookie is dead and the bot DMs you.
   Riot rotates cookies on every reauth, so the bot saves the new ones to `data/state.json` (mode 0600).
2. **Entitlements token:** `POST entitlements.auth.riotgames.com/api/token/v1`.
3. **PUUID:** `GET auth.riotgames.com/userinfo`. **Shard:** `PUT riot-geo.pas.si.riotgames.com/pas/v1/product/valorant`. You can override the shard with `RIOT_SHARD`.
4. **Storefront:** `POST pd.{shard}.a.pvp.net/store/v3/storefront/{puuid}` with body `{}`.
   - `X-Riot-ClientVersion` is fetched from valorant-api.com every hour, so it isn't pinned to a patch.
   - `X-Riot-ClientPlatform` is the standard PC blob.
5. **Item names, icons and rarity** come from valorant-api.com.
6. **Reset times** come from the `...RemainingDurationInSeconds` fields in the response.
   The scheduler re-arms itself for the next daily or night-market reset (plus 90 seconds). After each reset it checks your wishlist and DMs any hits.
   It records which shop it alerted on, so a restart doesn't send the same alert again.

## Setup

### 1. Discord application

1. Go to <https://discord.com/developers/applications> and create a **New Application**.
2. **Bot** tab: **Reset Token** and copy it into `DISCORD_TOKEN`. You don't need any privileged intents.
   Turn off **Public Bot** so nobody else can install it.
3. **Installation** tab:
   - Under Installation Contexts, enable **User Install**. Enable **Guild Install** too if you want it in a server.
   - Install Link: **Discord Provided Link**.
   - Default Install Settings: User Install → `applications.commands`. Guild Install (optional) → `applications.commands` and `bot`.
4. Open the install link and choose **Add to My Apps**.
5. **Emojis** tab (optional): upload *application* emojis named `vp`, `kc`, `select`, `deluxe`, `premium`, `exclusive` and `ultra`.
   They show up next to prices and rarities. Any you skip fall back to plain text.
   Application emojis work everywhere; guild emojis don't work for user installs.

> **About DMs:** a user-installed app can't post in channels on its own, so alerts arrive as DMs.
> Discord may refuse to let the bot DM you if you don't share a server with it.
> If alerts don't arrive, guild-install it into a private server of your own. A one-person server is enough.
> In servers that block external apps, replies are forced to ephemeral. That's fine.

### 2. Getting the ssid cookie

1. In a desktop browser, open:
   `https://auth.riotgames.com/authorize?redirect_uri=https%3A%2F%2Fplayvalorant.com%2Fopt_in&client_id=play-valorant-web-prod&response_type=token%20id_token&nonce=1&scope=account%20openid`
2. Log in and tick **Stay signed in**. You'll land on playvalorant.com.
3. Open DevTools (F12) → **Application** (Chrome) or **Storage** (Firefox) → **Cookies** → `https://auth.riotgames.com`.
4. Copy the value of `ssid` into `RIOT_SSID`.
   Alternatively, copy the whole cookie header for auth.riotgames.com into `RIOT_COOKIES`. Sending all the auth cookies tends to stay valid longer than `ssid` alone.

**Treat this cookie like your password.** It gives full account access.
It's invalidated by:

- a password change
- "sign out of all devices"
- 2FA changes
- Riot flagging the session

If it ever leaks, **change your Riot password**: that's the kill switch.

When it dies, the bot DMs you once. Paste a fresh cookie into `.env` and restart.
The bot notices the new env value and replaces the stored cookies with it.

### 3. Configure and run

```bash
cp .env.example .env    # fill in DISCORD_TOKEN, OWNER_ID, RIOT_SSID
npm ci
npm run check           # optional: fetch your shop once in the terminal, no Discord needed
npm run deploy-commands # register slash commands globally (may take a few minutes to show)
npm start
```

Or with Docker:

```bash
docker compose up -d --build
docker compose run --rm storefront node scripts/deploy-commands.js
```

State (the wishlist and the rotated cookies) is stored in the `storefront-data` volume, or in `./data` when you run it without Docker.
`.env` and `data/` are both gitignored and dockerignored.

Run `npm run deploy-commands` again whenever the command definitions change.

### Environment variables

| Variable | Required | Notes |
|---|---|---|
| `DISCORD_TOKEN` | yes | Bot token |
| `OWNER_ID` | yes | Your Discord user ID. The bot ignores everyone else. |
| `RIOT_SSID` / `RIOT_COOKIES` | yes | See above |
| `RIOT_SHARD` | no | `na`, `eu`, `ap` or `kr`. Detected automatically if unset. |
| `DAILY_DM` | no | `true` DMs you the full daily shop after every reset, not just wishlist hits |
| `DATA_DIR` | no | Default `./data` (`/data` in Docker) |
| `LOG_URLS` | no | Log request URLs (without query strings) for debugging |

## Development

```bash
npm test   # node:test, no network
```

Layout:

- `src/riot/`: Riot auth, a TLS-tuned HTTPS client, and the storefront call
- `src/content.js`: the valorant-api.com catalog
- `src/shop.js`: parses the storefront response (pure functions, unit-tested)
- `src/shops.js`: caching, the reset scheduler, wishlist alerts and dead-cookie notification
- `src/discord/`: slash commands and embeds

## Troubleshooting

- **"Riot auth blocked by Cloudflare (403)":** Riot is blocking the host's IP. This happens a lot on cloud/VPS IPs, so try hosting from home.
- **"Riot auth rate limited (429)":** wait a while. The scheduler retries hourly.
- **Storefront 400/404 after a patch:** check <https://valapidocs.techchrism.me> for endpoint changes, then run `npm run check`.
- **No DMs:** see the note about DMs under Setup. Check the logs for `50007`.
