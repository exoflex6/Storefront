"""Storefront - check your Valorant shop from Discord.

Anyone can register their own Riot account with /register (they paste their
ssid cookie into a private pop-up). Every other command asks unregistered users
to do that first. Each user then gets their own /shop, wishlist and DMs when
their shop resets.
"""

from __future__ import annotations

import asyncio
import logging
import os
from pathlib import Path

import aiohttp
import discord
from discord import app_commands
from dotenv import load_dotenv

from catalog import KIND_LABEL, Catalog
from embeds import Emojis, Group, paginate, relative, section_embeds, wishlist_item_embeds
from riot import REAUTH_URL, AuthError, RiotAPI, parse_cookie_input
from service import ShopService, describe_error
from shop import SECTION_LABEL, SECTIONS
from users import UserStore

load_dotenv()
logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] [%(levelname)-8s] %(name)s: %(message)s",
)
log = logging.getLogger("storefront")

HERE = Path(__file__).resolve().parent
USERS_FILE = Path(os.getenv("USERS_FILE") or HERE / "users.json")
# Optional comma-separated Discord user IDs allowed to register. Empty: anyone.
ALLOWED_USERS = {u.strip() for u in os.getenv("ALLOWED_USERS", "").split(",") if u.strip()}

REGISTER_TEXT = f"""\
**Add your Riot account**
1. In a desktop browser, open [this Riot sign-in page]({REAUTH_URL}) and sign in with **Stay signed in** ticked. You'll end up on playvalorant.com.
2. Press **F12** → **Application** (Chrome/Edge) or **Storage** (Firefox) → **Cookies** → `https://auth.riotgames.com`.
3. Copy the value of the `ssid` cookie.
4. Press **Add my cookie** below and paste it.

⚠️ That cookie is full access to your Riot account, so only give it to a bot you trust. \
It's kept on the bot's server and used only to read your shop. \
Changing your Riot password cancels it, and `/unregister` deletes it."""

NOT_REGISTERED = "You need to add your Riot account before you can use that. It takes about a minute:"


class Bot(discord.Client):
    def __init__(self) -> None:
        # Slash commands and DMs need no privileged intents. `guilds` is not privileged
        # and keeps discord.py's cache consistent.
        intents = discord.Intents.none()
        intents.guilds = True
        super().__init__(intents=intents)
        # Installable on servers and on user accounts, usable in servers, DMs and group DMs.
        self.tree = app_commands.CommandTree(
            self,
            allowed_installs=app_commands.AppInstallationType(guild=True, user=True),
            allowed_contexts=app_commands.AppCommandContext(guild=True, dm_channel=True, private_channel=True),
        )
        self.store = UserStore(USERS_FILE)
        self.app_emojis = Emojis()
        self.http_session: aiohttp.ClientSession | None = None
        self.service: ShopService | None = None
        self.scheduler: asyncio.Task | None = None

    async def setup_hook(self) -> None:
        # No cookie jar: every Riot request carries exactly one user's cookies.
        self.http_session = aiohttp.ClientSession(cookie_jar=aiohttp.DummyCookieJar())
        api = RiotAPI(self.http_session)
        catalog = Catalog(self.http_session)
        self.service = ShopService(api, catalog, self.store, self.app_emojis, self.dm)
        await self.app_emojis.load(self)
        try:
            await catalog.ensure_loaded()
        except Exception as exc:
            log.warning("item catalog not loaded yet (%s); will retry on first use", exc)
        await self.tree.sync()
        self.scheduler = asyncio.create_task(self._run_scheduler())

    async def _run_scheduler(self) -> None:
        while True:
            try:
                await self.service.run_scheduler()
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("scheduler crashed; restarting in 60s")
                await asyncio.sleep(60)

    async def dm(self, user_id: int, payload: dict) -> None:
        user = self.get_user(user_id) or await self.fetch_user(user_id)
        await user.send(**payload)

    async def on_ready(self) -> None:
        log.info("signed in as %s (%s)", self.user, self.user.id)

    async def close(self) -> None:
        if self.scheduler:
            self.scheduler.cancel()
        if self.http_session:
            await self.http_session.close()
        await super().close()


bot = Bot()


# --- registration -------------------------------------------------------------

class CookieModal(discord.ui.Modal, title="Add your Riot account"):
    cookie = discord.ui.TextInput(
        label="Your ssid cookie",
        style=discord.TextStyle.paragraph,
        placeholder="Paste the ssid value from auth.riotgames.com",
        max_length=4000,
    )

    async def on_submit(self, interaction: discord.Interaction) -> None:
        await interaction.response.defer(ephemeral=True, thinking=True)
        cookies = parse_cookie_input(self.cookie.value)
        if not cookies.get("ssid"):
            await interaction.followup.send("That doesn't look like an `ssid` cookie. Copy the value of `ssid` and try `/register` again.", ephemeral=True)
            return
        try:
            user, shop = await bot.service.register(interaction.user.id, cookies)
        except AuthError as exc:
            if exc.dead:
                msg = ("Riot didn't accept that cookie. Sign in again with **Stay signed in** ticked, "
                       "copy a fresh `ssid` and run `/register` again.")
            else:
                msg = describe_error(exc)
            await interaction.followup.send(msg, ephemeral=True)
            return
        on = ", ".join(SECTION_LABEL[s].lower() for s in SECTIONS if user["auto_post"][s]) or "nothing"
        lines = [
            f"✅ Registered{' as **' + user['riot_name'] + '**' if user['riot_name'] else ''}.",
            "Try `/shop`, `/accessories`, `/nightmarket`, `/bundle` or `/store`.",
            f"I'll DM you when your shop resets ({on}; change with `/autopost`) and when something on your `/wishlist` shows up.",
        ]
        if shop is None:
            lines.append("I couldn't load your shop just now; I'll keep trying.")
        await interaction.followup.send("\n".join(lines), ephemeral=True)


class RegisterView(discord.ui.View):
    def __init__(self) -> None:
        super().__init__(timeout=15 * 60)

    @discord.ui.button(label="Add my cookie", style=discord.ButtonStyle.primary, emoji="🔑")
    async def add(self, interaction: discord.Interaction, _button: discord.ui.Button) -> None:
        if not allowed(interaction.user.id):
            await interaction.response.send_message("This bot is invite-only.", ephemeral=True)
            return
        await interaction.response.send_modal(CookieModal())


def allowed(user_id: int) -> bool:
    return not ALLOWED_USERS or str(user_id) in ALLOWED_USERS


async def require_user(interaction: discord.Interaction) -> dict | None:
    """The caller's account, or None after asking them to register first."""
    user = bot.store.get(interaction.user.id)
    if user is None:
        await interaction.response.send_message(f"{NOT_REGISTERED}\n\n{REGISTER_TEXT}", view=RegisterView(), ephemeral=True, suppress_embeds=True)
    return user


@bot.tree.command(name="register", description="Add (or refresh) your Riot account so the bot can read your shop")
async def register(interaction: discord.Interaction) -> None:
    if not allowed(interaction.user.id):
        await interaction.response.send_message("This bot is invite-only.", ephemeral=True)
        return
    prefix = ""
    if bot.store.get(interaction.user.id):
        prefix = "You're already registered. Adding a new cookie replaces the old one and keeps your wishlist.\n\n"
    await interaction.response.send_message(prefix + REGISTER_TEXT, view=RegisterView(), ephemeral=True, suppress_embeds=True)


class ConfirmUnregister(discord.ui.View):
    def __init__(self) -> None:
        super().__init__(timeout=120)

    @discord.ui.button(label="Delete my data", style=discord.ButtonStyle.danger)
    async def confirm(self, interaction: discord.Interaction, _button: discord.ui.Button) -> None:
        bot.service.unregister(interaction.user.id)
        await interaction.response.edit_message(content="Done. Your cookie, wishlist and settings are deleted.", view=None)

    @discord.ui.button(label="Cancel", style=discord.ButtonStyle.secondary)
    async def cancel(self, interaction: discord.Interaction, _button: discord.ui.Button) -> None:
        await interaction.response.edit_message(content="Kept your account.", view=None)


@bot.tree.command(name="unregister", description="Delete your Riot cookie, wishlist and settings from the bot")
async def unregister(interaction: discord.Interaction) -> None:
    if await require_user(interaction) is None:
        return
    await interaction.response.send_message(
        "This deletes your stored Riot cookie, wishlist and settings. Sure?", view=ConfirmUnregister(), ephemeral=True,
    )


# --- shop views -----------------------------------------------------------------

async def send_shop(interaction: discord.Interaction, sections: tuple[str, ...], share: bool) -> None:
    user = await require_user(interaction)
    if user is None:
        return
    await interaction.response.defer(ephemeral=not share, thinking=True)
    try:
        shop = await bot.service.get(interaction.user.id)
    except Exception as exc:
        await interaction.followup.send(describe_error(exc), ephemeral=True)
        return
    groups = [Group(s, section_embeds(s, shop, bot.app_emojis, user["wishlist"])) for s in sections]
    for page in paginate(groups):
        await interaction.followup.send(embeds=page.embeds, ephemeral=not share)


SHARE = "Post it for everyone to see (default: only you)"


@bot.tree.command(name="shop", description="Your daily Valorant skin shop")
@app_commands.describe(share=SHARE)
async def shop_cmd(interaction: discord.Interaction, share: bool = False) -> None:
    await send_shop(interaction, ("daily",), share)


@bot.tree.command(name="accessories", description="Your Valorant accessory store")
@app_commands.describe(share=SHARE)
async def accessories_cmd(interaction: discord.Interaction, share: bool = False) -> None:
    await send_shop(interaction, ("accessories",), share)


@bot.tree.command(name="nightmarket", description="Your Valorant night market, if it's open")
@app_commands.describe(share=SHARE)
async def nightmarket_cmd(interaction: discord.Interaction, share: bool = False) -> None:
    await send_shop(interaction, ("night_market",), share)


@bot.tree.command(name="bundle", description="The current featured bundle(s)")
@app_commands.describe(share=SHARE)
async def bundle_cmd(interaction: discord.Interaction, share: bool = False) -> None:
    await send_shop(interaction, ("bundles",), share)


@bot.tree.command(name="store", description="Everything at once: daily shop, accessories, night market and bundles")
@app_commands.describe(share=SHARE)
async def store_cmd(interaction: discord.Interaction, share: bool = False) -> None:
    await send_shop(interaction, SECTIONS, share)


# --- wishlist -------------------------------------------------------------------

wishlist = app_commands.Group(name="wishlist", description="Skins and accessories to alert you about")
KIND_CHOICES = [app_commands.Choice(name=label, value=kind) for kind, label in KIND_LABEL.items()]


async def item_autocomplete(interaction: discord.Interaction, current: str) -> list[app_commands.Choice[str]]:
    user = bot.store.get(interaction.user.id)
    if user is None:
        return []
    catalog = bot.service.catalog
    try:
        await catalog.ensure_loaded()
    except Exception:
        return []
    if interaction.command and interaction.command.name == "remove":
        q = current.strip().casefold()
        items = [catalog.item(uuid) for uuid in user["wishlist"]]
        items = [i for i in items if q in i.name.casefold()]
    else:
        items = catalog.search(current, kind=getattr(interaction.namespace, "type", None))
    return [
        app_commands.Choice(name=f"{i.name} · {KIND_LABEL.get(i.kind, 'Item')}"[:100], value=i.uuid)
        for i in items[:25]
    ]


def find_item(pool, value: str, kind: str | None = None):
    for item in pool:
        if item.uuid == value and (not kind or item.kind == kind):
            return item
    wanted = value.strip().casefold()
    for item in pool:
        if (not kind or item.kind == kind) and item.name.casefold() == wanted:
            return item
    return None


@wishlist.command(name="add", description="Add a skin or accessory to your wishlist")
@app_commands.describe(type="What kind of item (pick this first)", item="Item name")
@app_commands.choices(type=KIND_CHOICES)
@app_commands.autocomplete(item=item_autocomplete)
async def wishlist_add(interaction: discord.Interaction, type: app_commands.Choice[str], item: str) -> None:
    user = await require_user(interaction)
    if user is None:
        return
    await interaction.response.defer(ephemeral=True, thinking=True)
    await bot.service.catalog.ensure_loaded()
    found = find_item(bot.service.catalog.wishlistable, item, type.value)
    if not found:
        await interaction.followup.send(f'No {type.name.lower()} matching "{item}". Pick one from the suggestions.', ephemeral=True)
        return
    if found.uuid in user["wishlist"]:
        await interaction.followup.send(f"**{found.name}** is already on your wishlist.", ephemeral=True)
        return
    user["wishlist"].append(found.uuid)
    bot.store.save()
    embeds = wishlist_item_embeds(found, bot.app_emojis, large=True, note="You'll get a DM when it shows up in your shop.")
    await interaction.followup.send("Added to your wishlist:", embeds=embeds, ephemeral=True)


@wishlist.command(name="remove", description="Remove an item from your wishlist")
@app_commands.describe(item="Item name")
@app_commands.autocomplete(item=item_autocomplete)
async def wishlist_remove(interaction: discord.Interaction, item: str) -> None:
    user = await require_user(interaction)
    if user is None:
        return
    await interaction.response.defer(ephemeral=True, thinking=True)
    await bot.service.catalog.ensure_loaded()
    found = find_item([bot.service.catalog.item(uuid) for uuid in user["wishlist"]], item)
    if not found:
        await interaction.followup.send(f'"{item}" isn\'t on your wishlist.', ephemeral=True)
        return
    user["wishlist"].remove(found.uuid)
    bot.store.save()
    await interaction.followup.send("Removed from your wishlist:", embeds=wishlist_item_embeds(found, bot.app_emojis), ephemeral=True)


@wishlist.command(name="list", description="Show your wishlist")
async def wishlist_list(interaction: discord.Interaction) -> None:
    user = await require_user(interaction)
    if user is None:
        return
    if not user["wishlist"]:
        await interaction.response.send_message("Your wishlist is empty - add items with `/wishlist add`.", ephemeral=True)
        return
    await interaction.response.defer(ephemeral=True, thinking=True)
    await bot.service.catalog.ensure_loaded()
    items = [bot.service.catalog.item(uuid) for uuid in user["wishlist"]]
    pages = paginate([Group("wishlist", wishlist_item_embeds(i, bot.app_emojis)) for i in items])
    for n, page in enumerate(pages):
        await interaction.followup.send(f"**Wishlist** ({len(items)})" if n == 0 else None, embeds=page.embeds, ephemeral=True)


bot.tree.add_command(wishlist)


# --- settings and status -------------------------------------------------------

@bot.tree.command(name="autopost", description="DM your full shop whenever it resets (no options: show your settings)")
@app_commands.describe(section="Which part of the shop", enabled="Turn automatic DMs on or off")
@app_commands.choices(section=[app_commands.Choice(name=SECTION_LABEL[s], value=s) for s in SECTIONS])
async def autopost(interaction: discord.Interaction, section: app_commands.Choice[str] | None = None, enabled: bool | None = None) -> None:
    user = await require_user(interaction)
    if user is None:
        return
    if section and enabled is not None:
        user["auto_post"][section.value] = enabled
        bot.store.save()
    elif section or enabled is not None:
        await interaction.response.send_message("Pick both a `section` and `enabled`, or neither to see your settings.", ephemeral=True)
        return
    lines = [f"{'✅' if user['auto_post'][s] else '⬜'} {SECTION_LABEL[s]}" for s in SECTIONS]
    await interaction.response.send_message(
        "**Automatic DMs when each section resets**\n" + "\n".join(lines) + "\n-# Wishlist alerts are always on.",
        ephemeral=True,
    )


@bot.tree.command(name="status", description="Your Riot login status and next shop resets")
async def status(interaction: discord.Interaction) -> None:
    user = await require_user(interaction)
    if user is None:
        return
    await interaction.response.defer(ephemeral=True, thinking=True)
    lines = []
    try:
        shop = await bot.service.get(interaction.user.id)
        lines.append(f"✅ Riot login OK{' as **' + user['riot_name'] + '**' if user['riot_name'] else ''} (shard `{user['shard']}`)")
        lines.append(f"Daily shop resets {relative(shop.daily.resets_at)}")
        lines.append(f"Accessories rotate {relative(shop.accessories.resets_at)}")
        lines.append(f"Night market closes {relative(shop.night_market.resets_at)}" if shop.night_market else "Night market: closed")
    except Exception as exc:
        lines.append(f"❌ {describe_error(exc)}")
    on = ", ".join(SECTION_LABEL[s].lower() for s in SECTIONS if user["auto_post"][s]) or "off"
    lines.append(f"Wishlist: {len(user['wishlist'])} item(s) · Auto-DMs: {on}")
    await interaction.followup.send("\n".join(lines), ephemeral=True)


@bot.tree.command(name="ping", description="Check the bot is alive")
async def ping(interaction: discord.Interaction) -> None:
    await interaction.response.send_message("pong", ephemeral=True)


@bot.tree.error
async def on_app_command_error(interaction: discord.Interaction, error: app_commands.AppCommandError) -> None:
    """Last resort, so a crash shows an error instead of "The application did not respond"."""
    original = getattr(error, "original", error)
    log.error("command %s failed", interaction.command.name if interaction.command else "?", exc_info=original)
    message = f"❌ {describe_error(original, 'finish that command')}"
    try:
        if interaction.response.is_done():
            await interaction.followup.send(message, ephemeral=True)
        else:
            await interaction.response.send_message(message, ephemeral=True)
    except discord.HTTPException as exc:
        log.error("could not report the error: %s", exc)


if __name__ == "__main__":
    token = os.getenv("DISCORD_TOKEN")
    if not token:
        raise SystemExit("DISCORD_TOKEN is not set - fill in .env")
    bot.run(token, log_handler=None)
