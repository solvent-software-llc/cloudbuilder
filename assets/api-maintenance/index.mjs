// The maintenance function for an API stack (src/api.ts). When the HTTP API's
// $default route points here instead of at the Go function, every request gets
// the maintenance response documented in README.md ("API maintenance mode"):
// 503, Retry-After, and a {"maintenance": true} body clients key off.
//
// CORS matters as much as the 503: without Access-Control-Allow-Origin a
// browser hides the response from the site's JavaScript, and an unanswered
// preflight means the real request is never even sent — either way the site
// sees a generic network error, not maintenance.

const RETRY_AFTER_SECONDS = "60";

export const handler = async (event) => {
    const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "").split(",").filter(Boolean);
    // HTTP API payload format 2.0 lowercases header names.
    const requestHeaders = event.headers ?? {};
    const origin = requestHeaders.origin;

    const headers = { "Cache-Control": "no-store", Vary: "Origin" };
    if (origin && allowedOrigins.includes(origin)) {
        headers["Access-Control-Allow-Origin"] = origin;
        headers["Access-Control-Allow-Credentials"] = "true";
        // Retry-After isn't a CORS-safelisted response header.
        headers["Access-Control-Expose-Headers"] = "Retry-After";
    }

    if (event.requestContext?.http?.method === "OPTIONS") {
        // Let the real request through so it can receive the 503. No
        // Access-Control-Max-Age: a preflight cached now would outlive the
        // maintenance window.
        if (headers["Access-Control-Allow-Origin"]) {
            const method = requestHeaders["access-control-request-method"];
            const allowHeaders = requestHeaders["access-control-request-headers"];
            if (method) headers["Access-Control-Allow-Methods"] = method;
            if (allowHeaders) headers["Access-Control-Allow-Headers"] = allowHeaders;
        }
        return { statusCode: 204, headers };
    }

    return {
        statusCode: 503,
        headers: {
            ...headers,
            "Content-Type": "application/json",
            "Retry-After": RETRY_AFTER_SECONDS,
        },
        body: JSON.stringify({ maintenance: true }),
    };
};
