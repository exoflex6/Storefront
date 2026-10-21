import { request } from "./http.js";
import { AuthError, cookieReauth, getEntitlementsToken, getShard, getUserInfo } from "./auth.js";

// Base64 of the tab-indented, CRLF-separated JSON the game client sends:
// {"platformType":"PC","platformOS":"Windows","platformOSVersion":"10.0.19042.1.256.64bit","platformChipset":"Unknown"}
// Same value as techchrism/valorant-api-docs "Client Platform".
export const CLIENT_PLATFORM =
    "ew0KCSJwbGF0Zm9ybVR5cGUiOiAiUEMiLA0KCSJwbGF0Zm9ybU9TIjogIldpbmRvd3MiLA0KCSJwbGF0Zm9ybU9TVmVyc2lvbiI6ICIxMC4wLjE5MDQyLjEuMjU2LjY0Yml0IiwNCgkicGxhdGZvcm1DaGlwc2V0IjogIlVua25vd24iDQp9";

const VERSION_TTL_MS = 60 * 60 * 1000;
// Refresh tokens a bit before Riot's 1h expiry.
const TOKEN_MARGIN_MS = 5 * 60 * 1000;

export class MaintenanceError extends Error {
    constructor() {
        super("Valorant is in scheduled maintenance");
        this.name = "MaintenanceError";
    }
}

export class RiotClient {
    /**
     * @param {import("../store.js").Store} store
     * @param {{shard?: string}} options
     */
    constructor(store, { shard = "" } = {}) {
        this.store = store;
        this.shardOverride = shard;
        this.session = null;
        this.version = null;
        this.pendingAuth = null;
    }

    async clientVersion() {
        if (this.version && Date.now() - this.version.fetchedAt < VERSION_TTL_MS) return this.version.value;
        const res = await fetch("https://valorant-api.com/v1/version");
        if (!res.ok) {
            if (this.version) return this.version.value; // stale beats nothing
            throw new Error(`valorant-api.com version lookup failed (${res.status})`);
        }
        const { data } = await res.json();
        this.version = { value: data.riotClientVersion, fetchedAt: Date.now() };
        return this.version.value;
    }

    /** Ensure we have a live session, re-authing with the stored cookies if needed. Concurrent callers share one attempt. */
    async auth({ force = false } = {}) {
        if (!force && this.session && this.session.expiresAt - TOKEN_MARGIN_MS > Date.now()) return this.session;
        this.pendingAuth ??= this.#reauth().finally(() => { this.pendingAuth = null; });
        return this.pendingAuth;
    }

    async #reauth() {
        this.session = null;
        const result = await cookieReauth(this.store.state.cookies);
        // Persist rotated cookies straight away: the old ssid may stop working.
        this.store.update((s) => { s.cookies = result.cookies; });

        const [entitlementsToken, user] = await Promise.all([
            getEntitlementsToken(result.accessToken),
            getUserInfo(result.accessToken),
        ]);
        const shard = this.shardOverride || await getShard(result.accessToken, result.idToken);

        this.session = { ...result, entitlementsToken, ...user, shard };
        delete this.session.cookies;
        return this.session;
    }

    async storefront() {
        let session = await this.auth();
        let res = await this.#postStorefront(session);
        let json = safeJson(res.body);

        // Token revoked early (e.g. a session refresh elsewhere): retry once with a fresh one.
        if (res.status === 400 && json?.errorCode === "BAD_CLAIMS") {
            session = await this.auth({ force: true });
            res = await this.#postStorefront(session);
            json = safeJson(res.body);
        }

        if (json?.errorCode === "SCHEDULED_DOWNTIME") throw new MaintenanceError();
        if (res.status === 400 && json?.errorCode === "BAD_CLAIMS") throw new AuthError("Storefront rejected fresh token (BAD_CLAIMS)");
        if (res.status !== 200 || !json) throw new Error(`Storefront request failed (${res.status}): ${res.body.slice(0, 200)}`);
        return json;
    }

    async #postStorefront(session) {
        return request(`https://pd.${session.shard}.a.pvp.net/store/v3/storefront/${session.puuid}`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${session.accessToken}`,
                "X-Riot-Entitlements-JWT": session.entitlementsToken,
                "X-Riot-ClientVersion": await this.clientVersion(),
                "X-Riot-ClientPlatform": CLIENT_PLATFORM,
            },
            body: {},
        });
    }
}

const safeJson = (text) => {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
};
