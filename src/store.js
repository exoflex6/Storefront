import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// Persistent bot state. Holds the (rotating) Riot cookies, so the file is
// written with 0600 permissions and lives in a gitignored directory.
const defaults = () => ({
    cookies: {},
    // Hash of the env cookie that seeded `cookies`; a new env value reseeds.
    seedHash: null,
    wishlist: [],
    // Last offer sets we alerted on, so restarts don't re-send the same DM.
    lastAlerted: { daily: null, accessories: null, nightMarket: null },
    authDeadNotified: false,
});

export class Store {
    constructor(dataDir) {
        this.file = path.join(dataDir, "state.json");
        fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
        this.state = defaults();
        if (fs.existsSync(this.file)) {
            const saved = JSON.parse(fs.readFileSync(this.file, "utf8"));
            this.state = { ...defaults(), ...saved, lastAlerted: { ...defaults().lastAlerted, ...saved.lastAlerted } };
        }
    }

    save() {
        const tmp = `${this.file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
        fs.renameSync(tmp, this.file);
    }

    update(fn) {
        fn(this.state);
        this.save();
    }

    /** Seed cookies from the env value if it's new (first run, or the user pasted a fresh cookie). */
    seedCookies(cookieHeader) {
        if (!cookieHeader) return;
        const hash = crypto.createHash("sha256").update(cookieHeader).digest("hex");
        if (hash === this.state.seedHash) return;
        this.update((s) => {
            s.cookies = parseCookieHeader(cookieHeader);
            s.seedHash = hash;
            s.authDeadNotified = false;
        });
    }
}

export const parseCookieHeader = (header) => {
    const cookies = {};
    for (const part of header.split(";")) {
        const sep = part.indexOf("=");
        if (sep === -1) continue;
        const name = part.slice(0, sep).trim();
        if (name) cookies[name] = part.slice(sep + 1).trim();
    }
    return cookies;
};

export const stringifyCookies = (cookies) =>
    Object.entries(cookies).map(([name, value]) => `${name}=${value}`).join("; ");
