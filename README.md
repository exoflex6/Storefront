# Storefront

A self-hosted Discord bot that shows Valorant shops. Each person registers their own Riot account and gets their own daily shop, accessory store, night market, featured bundles, wishlist alerts and reset DMs.

It replaces [SkinPeek](https://github.com/giorgi-o/SkinPeek), which was archived in June 2025. It's built with Python and discord.py to match the other bots on the homelab host. The earlier single-user Node version is in the git history.

## Commands

| Command | What it does |
|---|---|
| `/register` | Add or refresh your Riot account. Press **Click here to log in**, sign in on Riot's page, then press **I've logged in - paste URL** and paste the address your browser lands on (an error page on `localhost` is normal). **Use a cookie instead** is a fallback that takes an `ssid` cookie. |
| `/unregister` | Delete your Riot login, wishlist and settings, after you confirm. |
| `/shop` `/accessories` `/nightmarket` `/bundle` | One section of your shop. Add `share:true` to post it for everyone. |
| `/store` | All four sections at once. |
| `/wishlist add` / `remove` / `list` | `add` takes a required `type` first, then the `item` (suggestions are limited to that type, and only list items that can actually rotate into a shop). Covers skins, buddies, sprays, cards, titles and flex items, with pictures. Player cards show all three art views. |
| `/autopost` | Choose which sections get DMed to you when they reset. |
| `/status` | Shows your Riot login, shard and next reset times. |
| `/ping` | Checks the bot is alive. |

Any command other than `/register` and `/ping` asks an unregistered user to register first, and includes the same instructions and button.

All commands work in servers, in DMs with the bot and in group DMs. The app can be installed on a server or on a user's account.

### DMs

- **Wishlist alerts:** sent when a wishlisted item appears, once per rotation.
- **Reset posts:** your daily shop every day and your accessories every week, even when the items repeat. The night market (when it opens) and bundles (when they change) are off by default; turn them on with `/autopost`.
- **Expired login:** when your login stops working you get one DM asking you to `/register` again. Scheduled checks pause until you do.

### Staying logged in

**Link login (the default).** The login link is Riot's own sign-in page acting as the Riot Client (`client_id=riot-client`, `response_type=code`, scope `offline_access`). It ends on `http://localhost/redirect?code=...`. Nothing listens there, so the browser shows an error, but the address holds a one-time code. The bot trades that code at `auth.riotgames.com/token` for a **refresh token** and renews the login with it, so the login doesn't depend on any browser session. The code expires within about a minute, so paste it straight away.

**Cookie login (fallback).** Riot hands back a new `ssid` on every login, and that one stops working about 24 hours later: a login 24h00m18s after the previous one was rejected, while 23h59m49s was fine. The log records the attributes Riot sends with each new `ssid`, never its value.

Either way, the bot logs every user in again at least **every 6 hours** (`KEEPALIVE` in `service.py`) and saves whatever Riot hands back.

A login can still end early if you:

- change your password, use "sign out of all devices", or change 2FA.
- get the session flagged by Riot.
- (cookie login only) sign out of the browser session you copied the cookie from. That's why the cookie steps say to use a private window and close it without signing out.

Registering doesn't DM you the current shop. The first automatic post comes at the next reset.

## How it works

Everything goes through Riot's unofficial game-client API, not the official developer API, so it can break after a patch.

1. **Login:** for link logins, `POST auth.riotgames.com/token` with `grant_type=refresh_token` (or `authorization_code` at registration) and `client_id=riot-client`; `invalid_grant` means the login is dead. For cookie logins, `GET auth.riotgames.com/authorize?...` with the user's cookies, with the access token in the redirect fragment; a redirect to the login page means the cookie is dead.
2. **Entitlements token**, **PUUID** from `/userinfo`, and **shard** from riot-geo.
3. **Storefront:** `POST pd.{shard}.a.pvp.net/store/v3/storefront/{puuid}`. The client version comes from valorant-api.com, so it tracks game patches.
4. **Item data:** names, pictures and rarity from [valorant-api.com](https://valorant-api.com), refreshed every 12h.
5. **Scheduling:** reset times come from the `...RemainingDurationInSeconds` fields. Each user is checked 90 seconds after their next reset, with checks spaced 2 seconds apart so many users don't hit Riot's login at once.
6. **Delivery:** a shop section counts as posted only after the last DM carrying it is delivered. If a DM fails partway, only the undelivered sections are retried. If a user's DMs are closed, that rotation is skipped instead of retried every hour.

The bot sends each user's refresh token or cookies only to Riot. The aiohttp client has no cookie jar, so cookies can't leak between users.

## Privacy and security

- `users.json`, which sits beside `bot.py`, holds every registered user's Riot refresh token (or cookies, for cookie logins). **Those are full account access.** The file is written with mode 600 by a temp-file plus `os.replace`, and it's gitignored.
- The pasted address (or cookie) travels from Discord's pop-up to the bot, so Discord sees it in transit. Only register on a bot whose host you trust.
- A login is invalidated by a password change, "sign out of all devices", 2FA changes, or Riot flagging the session. **Changing your Riot password is the kill switch.**
- Set `ALLOWED_USERS` to limit who can register.
- Read-only store checks aren't known to cause bans, but this is a ToS gray area with no guarantees.

## Running it on the homelab bot host

The host conventions are in `/opt/bots/BOTS.md` on `botslxc`. The unit and directory are both named `storefront`.

**First time:**

1. Set up the Discord application (see the next section).
2. Run `ssh botslxc -t '/opt/bots/newbot.sh storefront "Storefront Valorant shop bot"'` and paste the token when it asks. This creates `/opt/bots/storefront`, a venv owned by the `bots` user, the systemd unit and the web manager registry line.
3. Run `./deploy.sh` from this repo to replace the scaffold with this code.

**Updates:** commit, then run `./deploy.sh`. It copies the committed code over SSH, never touching `.env` or `users.json`, reinstalls requirements, restarts the bot and prints the log.

**Checks on the host:**

```bash
systemctl is-active storefront
journalctl -u storefront -n 40 --no-pager
```

It's also listed at https://discord-bots.javno.zone.

### Discord application

1. Go to https://discord.com/developers/applications and create a **New Application**.
2. On the **Bot** tab, click **Reset Token** and copy the token. It's only shown once. Don't tick any privileged intents; the bot needs none.
3. On the **Installation** tab, tick both **User Install** and **Guild Install**. Give Guild Install the scopes `bot` and `applications.commands`, and User Install the scope `applications.commands`.
4. Open the install link. Add the bot to a server, and/or choose **Add to My Apps**.
5. Optional: upload application emojis named `vp`, `kc`, `select`, `deluxe`, `premium`, `exclusive` and `ultra` on the **Emojis** tab, for prices and rarity.
6. Optional: use `assets/branding/icon.png` as the app icon and `banner.png` as the bot banner.

The bot can only DM someone it shares a server with, or someone who added the app to their account. If DMs don't arrive, add the bot to a server with that person.

## Development

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python -m unittest discover -s tests -t .
```

Tests use fake Riot and Discord objects and need no token or cookie.
Never run the same Discord token in two places. Stop the host's copy before running it locally.

## What can be wishlisted

Only items that can actually show up in a shop are suggested and accepted:

- **Skins:** any skin with a rarity, except battle pass and agent contract rewards and limited releases that never rotate back: Champions, VCT capsules and LOCK//IN, Arcane, and the Ignite Fan (`LIMITED_SKIN_PREFIXES` in `catalog.py`). Riot's list of sellable items (`/store/v1/offers`) used to answer this directly, but it now returns 404.
- **Accessories** (buddies, sprays, cards, titles, flex): rewards from past battle passes and event passes, which is what the accessory store rotates. Agent contract rewards are excluded because they're always earnable from the agent.
- **Anything seen in a real shop** always counts, in case the rules above miss something. These items are remembered in `rotation.json` beside the code.
