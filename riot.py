"""Riot's unofficial client API: cookie re-auth, entitlements, shard and storefront.

None of this is Riot's official developer API. It can break after a patch; the
client version is fetched from valorant-api.com so it tracks game updates.

Every request carries one user's cookies explicitly. The aiohttp session uses a
DummyCookieJar so cookies can never leak from one registered user to another.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass, field
from urllib.parse import parse_qs

import aiohttp

log = logging.getLogger("storefront.riot")

REAUTH_URL = (
    "https://auth.riotgames.com/authorize"
    "?redirect_uri=https%3A%2F%2Fplayvalorant.com%2Fopt_in"
    "&client_id=play-valorant-web-prod"
    "&response_type=token%20id_token"
    "&nonce=1"
    "&scope=account%20openid"
)

# The RiotClient/... user agent started triggering hCaptcha; this one doesn't.
AUTH_USER_AGENT = "ShooterGame/13 Windows/10.0.19043.1.256.64bit"

# Base64 of the tab-indented, CRLF-separated JSON the game client sends:
# {"platformType":"PC","platformOS":"Windows","platformOSVersion":"10.0.19042.1.256.64bit","platformChipset":"Unknown"}
CLIENT_PLATFORM = (
    "ew0KCSJwbGF0Zm9ybVR5cGUiOiAiUEMiLA0KCSJwbGF0Zm9ybU9TIjogIldpbmRvd3MiLA0KCSJwbGF0Zm9ybU9T"
    "VmVyc2lvbiI6ICIxMC4wLjE5MDQyLjEuMjU2LjY0Yml0IiwNCgkicGxhdGZvcm1DaGlwc2V0IjogIlVua25vd24iDQp9"
)

VERSION_TTL = 60 * 60
# Refresh tokens a bit before Riot's 1h expiry.
TOKEN_MARGIN = 5 * 60
TIMEOUT = aiohttp.ClientTimeout(total=20)


class AuthError(Exception):
    """`dead`: the cookie is no longer valid and the user has to give a new one.

    Anything else (rate limit, Cloudflare, network) is transient and worth retrying.
    """

    def __init__(self, message: str, *, dead: bool = False):
        super().__init__(message)
        self.dead = dead


class MaintenanceError(Exception):
    def __init__(self) -> None:
        super().__init__("Valorant is in scheduled maintenance")


# --- cookies ------------------------------------------------------------------

def parse_cookie_input(text: str) -> dict[str, str]:
    """Accept a bare ssid value, `ssid=...`, or a whole `a=1; b=2` cookie header."""
    text = text.strip().strip('"').strip()
    if text.lower().startswith("cookie:"):
        text = text[len("cookie:"):].strip()
    if "=" not in text:
        return {"ssid": text} if text else {}
    cookies: dict[str, str] = {}
    for part in text.split(";"):
        name, sep, value = part.partition("=")
        name = name.strip()
        if sep and name:
            cookies[name] = value.strip()
    return cookies


def cookie_header(cookies: dict[str, str]) -> str:
    return "; ".join(f"{name}={value}" for name, value in cookies.items())


def merge_set_cookies(jar: dict[str, str], set_cookie: list[str]) -> dict[str, str]:
    """Apply Set-Cookie headers. Riot rotates ssid on re-auth, so this must be saved."""
    merged = dict(jar)
    for line in set_cookie:
        name, sep, value = line.split(";", 1)[0].partition("=")
        name, value = name.strip(), value.strip()
        if not sep or not name:
            continue
        # Riot clears cookies by setting them empty; drop those instead of storing "".
        if value:
            merged[name] = value
        else:
            merged.pop(name, None)
    return merged


def parse_reauth_location(location: str | None) -> dict | None:
    """Tokens from the re-auth redirect, or None if it sent us to the login page."""
    if not location or "#" not in location:
        return None
    params = {k: v[0] for k, v in parse_qs(location.split("#", 1)[1]).items()}
    if not params.get("access_token"):
        return None
    return {
        "access_token": params["access_token"],
        "id_token": params.get("id_token"),
        "expires_at": time.time() + int(params.get("expires_in") or 3600),
    }


def region_to_shard(region: str) -> str:
    # latam and br play on the na shard; the rest map 1:1.
    return "na" if region in ("latam", "br") else region


# --- API ------------------------------------------------------------------------

@dataclass
class Session:
    access_token: str
    id_token: str | None
    expires_at: float
    entitlements_token: str
    puuid: str
    name: str | None
    shard: str
    cookies: dict[str, str] = field(repr=False, default_factory=dict)


class RiotAPI:
    """Stateless HTTP calls plus a cached client version. One instance for all users."""

    def __init__(self, http: aiohttp.ClientSession):
        self.http = http
        self._version: tuple[str, float] | None = None

    async def client_version(self) -> str:
        if self._version and time.time() - self._version[1] < VERSION_TTL:
            return self._version[0]
        try:
            async with self.http.get("https://valorant-api.com/v1/version", timeout=TIMEOUT) as res:
                res.raise_for_status()
                data = (await res.json())["data"]
        except Exception:
            if self._version:
                return self._version[0]  # stale beats nothing
            raise
        self._version = (data["riotClientVersion"], time.time())
        return self._version[0]

    async def login(self, cookies: dict[str, str]) -> Session:
        """Full re-auth with a user's cookies. Raises AuthError(dead=True) if they're invalid."""
        if not cookies.get("ssid"):
            raise AuthError("no ssid cookie", dead=True)

        async with self.http.get(
            REAUTH_URL,
            headers={"User-Agent": AUTH_USER_AGENT, "Cookie": cookie_header(cookies)},
            allow_redirects=False,
            timeout=TIMEOUT,
        ) as res:
            status = res.status
            location = res.headers.get("Location")
            set_cookie = res.headers.getall("Set-Cookie", [])

        if status == 429:
            raise AuthError("Riot login is rate limiting this server (429)")
        if status == 403:
            raise AuthError("Riot login blocked this server (403)")
        if not 300 <= status < 400:
            raise AuthError(f"unexpected Riot login status {status}")
        tokens = parse_reauth_location(location)
        if not tokens:
            raise AuthError("cookie rejected - Riot asked to log in again", dead=True)

        bearer = {"Authorization": f"Bearer {tokens['access_token']}"}
        entitlements, user = await asyncio.gather(
            self._json("POST", "https://entitlements.auth.riotgames.com/api/token/v1", bearer, {}),
            self._json("GET", "https://auth.riotgames.com/userinfo", bearer),
        )
        geo = await self._json(
            "PUT", "https://riot-geo.pas.si.riotgames.com/pas/v1/product/valorant", bearer,
            {"id_token": tokens["id_token"]},
        )
        acct = user.get("acct") or {}
        return Session(
            access_token=tokens["access_token"],
            id_token=tokens["id_token"],
            expires_at=tokens["expires_at"],
            entitlements_token=entitlements["entitlements_token"],
            puuid=user["sub"],
            name=f"{acct['game_name']}#{acct['tag_line']}" if acct.get("game_name") else None,
            shard=region_to_shard(geo["affinities"]["live"]),
            cookies=merge_set_cookies(cookies, set_cookie),
        )

    async def _json(self, method: str, url: str, headers: dict, body: dict | None = None) -> dict:
        async with self.http.request(method, url, headers=headers, json=body, timeout=TIMEOUT) as res:
            if res.status != 200:
                raise AuthError(f"{url.split('/')[2]} returned {res.status}")
            return await res.json(content_type=None)

    async def storefront(self, session: Session) -> tuple[int, dict | None, str]:
        async with self.http.post(
            f"https://pd.{session.shard}.a.pvp.net/store/v3/storefront/{session.puuid}",
            headers={
                "Authorization": f"Bearer {session.access_token}",
                "X-Riot-Entitlements-JWT": session.entitlements_token,
                "X-Riot-ClientVersion": await self.client_version(),
                "X-Riot-ClientPlatform": CLIENT_PLATFORM,
            },
            json={},
            timeout=TIMEOUT,
        ) as res:
            text = await res.text()
        try:
            return res.status, json.loads(text), text
        except ValueError:
            return res.status, None, text


    async def offers(self, session: Session) -> dict:
        """Every item Riot sells for VP (GET /store/v1/offers). Same for all accounts on a shard."""
        async with self.http.get(
            f"https://pd.{session.shard}.a.pvp.net/store/v1/offers/",
            headers={
                "Authorization": f"Bearer {session.access_token}",
                "X-Riot-Entitlements-JWT": session.entitlements_token,
                "X-Riot-ClientVersion": await self.client_version(),
                "X-Riot-ClientPlatform": CLIENT_PLATFORM,
            },
            timeout=TIMEOUT,
        ) as res:
            if res.status != 200:
                raise RuntimeError(f"store offers request failed ({res.status}): {(await res.text())[:200]}")
            return await res.json(content_type=None)


class RiotAccount:
    """One registered user's Riot login. Re-auths with their cookies when needed.

    `on_cookies` is called with the rotated cookies after every login so they can be saved:
    the old ssid may stop working once Riot has issued a new one.
    """

    def __init__(self, api: RiotAPI, cookies: dict[str, str], on_cookies):
        self.api = api
        self.cookies = cookies
        self.on_cookies = on_cookies
        self.session: Session | None = None
        self._lock = asyncio.Lock()

    async def auth(self, *, force: bool = False) -> Session:
        async with self._lock:
            if not force and self.session and self.session.expires_at - TOKEN_MARGIN > time.time():
                return self.session
            self.session = None
            session = await self.api.login(self.cookies)
            self.cookies = session.cookies
            self.on_cookies(session.cookies)
            self.session = session
            return session

    async def storefront(self) -> dict:
        session = await self.auth()
        status, body, text = await self.api.storefront(session)
        # Token revoked early (e.g. a session refresh elsewhere): retry once with a fresh one.
        if status == 400 and body and body.get("errorCode") == "BAD_CLAIMS":
            session = await self.auth(force=True)
            status, body, text = await self.api.storefront(session)
        if body and body.get("errorCode") == "SCHEDULED_DOWNTIME":
            raise MaintenanceError()
        if status == 400 and body and body.get("errorCode") == "BAD_CLAIMS":
            raise AuthError("Riot rejected a fresh token (BAD_CLAIMS)")
        if status != 200 or body is None:
            raise RuntimeError(f"storefront request failed ({status}): {text[:200]}")
        return body

    async def offers(self) -> dict:
        return await self.api.offers(await self.auth())
