import path from "node:path";

// Load .env if present (Node >= 21.7). Real env vars win over the file.
try {
    process.loadEnvFile();
} catch {
    // no .env file - rely on the process environment (e.g. Docker secrets/env)
}

const bool = (value, fallback) => {
    if (value === undefined || value === "") return fallback;
    return ["1", "true", "yes", "on"].includes(value.toLowerCase());
};

const required = (name) => {
    const value = process.env[name];
    if (!value) throw new Error(`Missing required environment variable ${name} (see .env.example)`);
    return value;
};

export const config = {
    get discordToken() { return required("DISCORD_TOKEN"); },
    get ownerId() { return required("OWNER_ID"); },
    // Either a bare ssid value or a full "name=value; name2=value2" cookie header.
    riotCookieSeed: process.env.RIOT_COOKIES || (process.env.RIOT_SSID ? `ssid=${process.env.RIOT_SSID}` : ""),
    // Optional override; otherwise detected from the account via riot-geo.
    shard: process.env.RIOT_SHARD || "",
    dataDir: path.resolve(process.env.DATA_DIR || "./data"),
    // DM the full daily shop after every reset, not just wishlist hits.
    dailyDm: bool(process.env.DAILY_DM, false),
    logUrls: bool(process.env.LOG_URLS, false),
};
