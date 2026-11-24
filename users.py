"""Registered users, one JSON file beside the code.

The file holds every registered user's Riot cookies, which are full account
access, so it is written with mode 600 (temp file + os.replace, so a crash
mid-write never leaves a half-written file) and is gitignored.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
import time
from pathlib import Path

from shop import SECTIONS

log = logging.getLogger("storefront.users")


def default_auto_post() -> dict[str, bool]:
    # The full daily shop and accessory rotation by DM; night market and bundles on request.
    return {"daily": True, "accessories": True, "night_market": False, "bundles": False}


def new_user(cookies: dict[str, str]) -> dict:
    return {
        "cookies": cookies,
        "riot_name": None,
        "puuid": None,
        "shard": None,
        "registered_at": int(time.time()),
        "wishlist": [],
        # Last rotation posted per section, so restarts don't re-send the same DM.
        "last_posted": {name: None for name in SECTIONS},
        "auto_post": default_auto_post(),
        # Set once we've told the user their cookie died; cleared when they re-register.
        "auth_dead": False,
    }


class UserStore:
    def __init__(self, path: Path):
        self.path = path
        self.users: dict[str, dict] = {}
        if path.exists():
            with path.open(encoding="utf-8") as handle:
                self.users = json.load(handle)
            for user in self.users.values():
                user.setdefault("wishlist", [])
                user["last_posted"] = {**{n: None for n in SECTIONS}, **(user.get("last_posted") or {})}
                user["auto_post"] = {**default_auto_post(), **(user.get("auto_post") or {})}
                user.setdefault("auth_dead", False)
        log.info("%d registered user(s)", len(self.users))

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix=".users-", dir=self.path.parent)
        try:
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(self.users, handle, indent=2)
            os.replace(tmp, self.path)
        except BaseException:
            Path(tmp).unlink(missing_ok=True)
            raise

    def get(self, user_id: int | str) -> dict | None:
        return self.users.get(str(user_id))

    def put(self, user_id: int | str, user: dict) -> None:
        self.users[str(user_id)] = user
        self.save()

    def remove(self, user_id: int | str) -> bool:
        removed = self.users.pop(str(user_id), None) is not None
        if removed:
            self.save()
        return removed

    def ids(self) -> list[str]:
        return list(self.users)
