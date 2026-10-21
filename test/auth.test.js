import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeSetCookies, parseReauthLocation, regionToShard } from "../src/riot/auth.js";
import { CLIENT_PLATFORM } from "../src/riot/client.js";
import { parseCookieHeader, stringifyCookies } from "../src/store.js";

test("reauth success redirect yields tokens", () => {
    const tokens = parseReauthLocation("https://playvalorant.com/opt_in#access_token=AT&scope=openid&iss=x&id_token=IT&token_type=Bearer&session_state=s&expires_in=3600");
    assert.equal(tokens.accessToken, "AT");
    assert.equal(tokens.idToken, "IT");
    assert.ok(tokens.expiresAt > Date.now());
});

test("reauth redirect to login means the cookie is dead", () => {
    assert.equal(parseReauthLocation("https://authenticate.riotgames.com/login?client_id=play-valorant-web-prod&nonce=1"), null);
    assert.equal(parseReauthLocation("/login"), null);
    assert.equal(parseReauthLocation(undefined), null);
});

test("Set-Cookie rotation replaces ssid and drops cleared cookies", () => {
    const jar = mergeSetCookies({ ssid: "old", clid: "c", tdid: "t" }, [
        "ssid=new; Path=/; Domain=auth.riotgames.com; Secure; HttpOnly",
        "tdid=; Path=/; Max-Age=0",
        "sub=abc; Path=/",
    ]);
    assert.deepEqual(jar, { ssid: "new", clid: "c", sub: "abc" });
});

test("cookie header round-trips", () => {
    const cookies = parseCookieHeader("ssid=abc.def==; clid=uw1 ; junk");
    assert.deepEqual(cookies, { ssid: "abc.def==", clid: "uw1" });
    assert.equal(stringifyCookies(cookies), "ssid=abc.def==; clid=uw1");
});

test("latam and br use the na shard", () => {
    assert.equal(regionToShard("latam"), "na");
    assert.equal(regionToShard("br"), "na");
    assert.equal(regionToShard("eu"), "eu");
});

test("client platform matches the game client's tab-indented CRLF JSON", () => {
    const json = JSON.stringify({
        platformType: "PC",
        platformOS: "Windows",
        platformOSVersion: "10.0.19042.1.256.64bit",
        platformChipset: "Unknown",
    }, null, "\t").replace(/\n/g, "\r\n");
    // The docs' blob has a space after each colon, which JSON.stringify doesn't emit.
    const decoded = Buffer.from(CLIENT_PLATFORM, "base64").toString("utf8");
    assert.deepEqual(JSON.parse(decoded), JSON.parse(json));
    assert.ok(decoded.includes("\r\n\t"));
});
