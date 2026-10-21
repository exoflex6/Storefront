import https from "node:https";
import { config } from "../config.js";

// Riot's auth endpoints sit behind Cloudflare, which rejects Node's default TLS
// fingerprint. This cipher/sigalg set mirrors what SkinPeek found to work.
const ciphers = [
    "TLS_CHACHA20_POLY1305_SHA256",
    "TLS_AES_128_GCM_SHA256",
    "TLS_AES_256_GCM_SHA384",
    "ECDHE-ECDSA-CHACHA20-POLY1305",
    "ECDHE-RSA-CHACHA20-POLY1305",
    "ECDHE-ECDSA-AES128-SHA256",
    "ECDHE-RSA-AES128-SHA256",
    "ECDHE-ECDSA-AES256-GCM-SHA384",
    "ECDHE-RSA-AES256-GCM-SHA384",
    "ECDHE-ECDSA-AES128-SHA",
    "ECDHE-RSA-AES128-SHA",
    "ECDHE-ECDSA-AES256-SHA",
    "ECDHE-RSA-AES256-SHA",
].join(":");

const sigalgs = [
    "ecdsa_secp256r1_sha256",
    "rsa_pss_rsae_sha256",
    "rsa_pkcs1_sha256",
    "ecdsa_secp384r1_sha384",
    "rsa_pss_rsae_sha384",
    "rsa_pkcs1_sha384",
    "rsa_pss_rsae_sha512",
    "rsa_pkcs1_sha512",
    "rsa_pkcs1_sha1",
].join(":");

/**
 * Minimal HTTPS request that does not follow redirects (the cookie reauth
 * token lives in the redirect's Location header).
 * @returns {Promise<{status: number, headers: import("node:http").IncomingHttpHeaders, body: string, json: () => any}>}
 */
export const request = (url, { method = "GET", headers = {}, body, timeoutMs = 15000 } = {}) => {
    // Never log query strings or fragments: they can carry tokens.
    if (config.logUrls) console.log(`[http] ${method} ${url.split("?")[0]}`);

    return new Promise((resolve, reject) => {
        const req = https.request(url, {
            method,
            headers: {
                "Accept-Language": "en-US,en;q=0.9",
                ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
                ...headers,
            },
            ciphers,
            sigalgs,
            minVersion: "TLSv1.3",
            timeout: timeoutMs,
        }, (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => {
                const text = Buffer.concat(chunks).toString("utf8");
                resolve({
                    status: res.statusCode,
                    headers: res.headers,
                    body: text,
                    json: () => JSON.parse(text),
                });
            });
            res.on("error", reject);
        });
        req.on("timeout", () => req.destroy(new Error(`Request to ${new URL(url).host} timed out`)));
        req.on("error", reject);
        if (body !== undefined) req.write(typeof body === "string" ? body : JSON.stringify(body));
        req.end();
    });
};
