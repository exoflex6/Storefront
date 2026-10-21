import { AuthError } from "./riot/auth.js";
import { MaintenanceError } from "./riot/client.js";

export const REFRESH_INSTRUCTIONS =
    "Grab a fresh `ssid` cookie (see \"Getting the ssid cookie\" in the README), "
    + "put it in `RIOT_SSID` in the bot's `.env`, and restart the bot.";

/** User-facing one-liner for a failed shop fetch. Never includes tokens or cookies. */
export const describeError = (err) => {
    if (err instanceof AuthError && err.dead) return `Riot login expired: ${err.message}. ${REFRESH_INSTRUCTIONS}`;
    if (err instanceof AuthError) return `Riot auth failed (temporary?): ${err.message}`;
    if (err instanceof MaintenanceError) return "Valorant is in scheduled maintenance - try again later.";
    return `Couldn't fetch the shop: ${err.message}`;
};
