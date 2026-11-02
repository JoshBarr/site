import { createHash, createHmac } from "node:crypto";

// Signatures as QStash makes them: a JWT, signed with the current or next
// signing key, carrying a hash of the body.

const base64url = (value: string) => Buffer.from(value).toString("base64url");

/** The `Upstash-Signature` QStash would send with `body`, signed with `key`. */
export function sign(body: string, key = "current-signing-key") {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));

  const payload = base64url(
    JSON.stringify({
      iss: "Upstash",
      sub: "https://joshbarr.com/api/flights/sweep",
      iat: now,
      nbf: now,
      exp: now + 300,
      jti: "test",
      body: createHash("sha256").update(body).digest("base64url"),
    })
  );

  const signature = createHmac("sha256", key)
    .update(`${header}.${payload}`)
    .digest("base64url");

  return `${header}.${payload}.${signature}`;
}
