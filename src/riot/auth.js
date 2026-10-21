import { request } from "./http.js";
import { stringifyCookies } from "../store.js";

const REAUTH_URL = "https://auth.riotgames.com/authorize"
    + "?redirect_uri=https%3A%2F%2Fplayvalorant.com%2Fopt_in"
    + "&client_id=play-valorant-web-prod"
    + "&response_type=token%20id_token"
    + "&nonce=1"
    + "&scope=account%20openid";

// The RiotClient/... user agent started triggering hCaptcha; this one doesn't (SkinPeek #93).
const AUTH_USER_AGENT = "ShooterGame/13 Windows/10.0.19043.1.256.64bit";

/**
 * `dead`: the cookie is no longer valid and a human has to paste a new one.
 * Anything else (rate limit, Cloudflare, network) is transient and worth retrying.
 */
export class AuthError extends Error {
    constructor(message, { dead = false } = {}) {
        super(message);
        this.name = "AuthError";
        this.dead = dead;
    }
}

/** Merge Set-Cookie headers into a cookie jar. Riot rotates ssid on reauth, so this must be persisted. */
export const mergeSetCookies = (jar, setCookie = []) => {
    const next = { ...jar };
    for (const line of setCookie) {
        const pair = line.split(";")[0];
        const sep = pair.indexOf("=");
        if (sep === -1) continue;
        const name = pair.slice(0, sep).trim();
        const value = pair.slice(sep + 1).trim();
        // Riot clears cookies by setting them empty; drop those instead of storing "".
        if (value === "") delete next[name];
        else next[name] = value;
    }
    return next;
};

/** Pull tokens out of the reauth redirect; returns null if it redirected to the login page. */
export const parseReauthLocation = (location) => {
    if (!location) return null;
    const hash = location.indexOf("#");
    if (hash === -1) return null;
    const params = new URLSearchParams(location.slice(hash + 1));
    const accessToken = params.get("access_token");
    if (!accessToken) return null;
    return {
        accessToken,
        idToken: params.get("id_token"),
        expiresAt: Date.now() + Number(params.get("expires_in") || 3600) * 1000,
    };
};

export const cookieReauth = async (cookies) => {
    if (!cookies.ssid) throw new AuthError("No ssid cookie configured", { dead: true });

    const res = await request(REAUTH_URL, {
        headers: { "User-Agent": AUTH_USER_AGENT, Cookie: stringifyCookies(cookies) },
    });

    if (res.status === 429) throw new AuthError("Riot auth rate limited (429)");
    if (res.status === 403) throw new AuthError("Riot auth blocked by Cloudflare (403) - check the host's IP");
    if (res.status < 300 || res.status >= 400) throw new AuthError(`Unexpected reauth status ${res.status}`);

    const tokens = parseReauthLocation(res.headers.location);
    if (!tokens) throw new AuthError("ssid cookie rejected (redirected to login)", { dead: true });

    return { ...tokens, cookies: mergeSetCookies(cookies, res.headers["set-cookie"]) };
};

export const getEntitlementsToken = async (accessToken) => {
    const res = await request("https://entitlements.auth.riotgames.com/api/token/v1", {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}` },
        body: {},
    });
    if (res.status !== 200) throw new AuthError(`Entitlements request failed (${res.status})`);
    return res.json().entitlements_token;
};

export const getUserInfo = async (accessToken) => {
    const res = await request("https://auth.riotgames.com/userinfo", {
        headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.status !== 200) throw new AuthError(`userinfo request failed (${res.status})`);
    const json = res.json();
    const name = json.acct?.game_name ? `${json.acct.game_name}#${json.acct.tag_line}` : null;
    return { puuid: json.sub, name };
};

// latam and br play on the na shard; the rest map 1:1.
export const regionToShard = (region) => (region === "latam" || region === "br" ? "na" : region);

export const getShard = async (accessToken, idToken) => {
    const res = await request("https://riot-geo.pas.si.riotgames.com/pas/v1/product/valorant", {
        method: "PUT",
        headers: { Authorization: `Bearer ${accessToken}` },
        body: { id_token: idToken },
    });
    if (res.status !== 200) throw new AuthError(`riot-geo request failed (${res.status})`);
    return regionToShard(res.json().affinities.live);
};
