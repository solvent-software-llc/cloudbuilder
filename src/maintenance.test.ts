import { describe, it, expect, beforeEach } from "vitest";
// @ts-expect-error: plain-JS Lambda asset, no type declarations
import { handler } from "../assets/api-maintenance/index.mjs";

const SITE = "https://example.com";

const event = (method: string, headers: Record<string, string> = {}) => ({
    headers,
    requestContext: { http: { method } },
});

describe("maintenance handler", () => {
    beforeEach(() => {
        process.env.ALLOWED_ORIGINS = `${SITE},https://www.example.com`;
    });

    it("returns 503 with the maintenance body and CORS for an allowed origin", async () => {
        const res = await handler(event("GET", { origin: SITE }));
        expect(res.statusCode).toBe(503);
        expect(JSON.parse(res.body)).toEqual({ maintenance: true });
        expect(res.headers).toMatchObject({
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            "Retry-After": "60",
            "Access-Control-Allow-Origin": SITE,
            "Access-Control-Allow-Credentials": "true",
            "Access-Control-Expose-Headers": "Retry-After",
        });
    });

    it("omits CORS headers for an origin not on the allow-list", async () => {
        const res = await handler(event("POST", { origin: "https://evil.example" }));
        expect(res.statusCode).toBe(503);
        expect(res.headers["Access-Control-Allow-Origin"]).toBeUndefined();
        expect(res.headers["Access-Control-Allow-Credentials"]).toBeUndefined();
    });

    it("returns 503 without CORS headers for non-browser clients", async () => {
        const res = await handler(event("GET"));
        expect(res.statusCode).toBe(503);
        expect(JSON.parse(res.body)).toEqual({ maintenance: true });
        expect(res.headers["Access-Control-Allow-Origin"]).toBeUndefined();
    });

    it("answers an allowed preflight so the real request goes out", async () => {
        const res = await handler(
            event("OPTIONS", {
                origin: SITE,
                "access-control-request-method": "POST",
                "access-control-request-headers": "authorization,content-type",
            }),
        );
        expect(res.statusCode).toBe(204);
        expect(res.body).toBeUndefined();
        expect(res.headers).toMatchObject({
            "Access-Control-Allow-Origin": SITE,
            "Access-Control-Allow-Credentials": "true",
            "Access-Control-Allow-Methods": "POST",
            "Access-Control-Allow-Headers": "authorization,content-type",
        });
        expect(res.headers["Access-Control-Max-Age"]).toBeUndefined();
    });

    it("does not grant a preflight from a disallowed origin", async () => {
        const res = await handler(
            event("OPTIONS", { origin: "https://evil.example", "access-control-request-method": "POST" }),
        );
        expect(res.statusCode).toBe(204);
        expect(res.headers["Access-Control-Allow-Origin"]).toBeUndefined();
        expect(res.headers["Access-Control-Allow-Methods"]).toBeUndefined();
    });
});
