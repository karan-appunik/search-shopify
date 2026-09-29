"use strict";

// =========================================================
// DEVELOPER DASHBOARD SERVER
// =========================================================
//
// A small, dependency-free Node HTTP server (Node's built-in
// `http` and `fetch` only — no npm install required to run
// this). It exists so the app creator can inspect application
// data without going through Shopify OAuth/App Bridge, which
// the embedded Admin app requires.
//
// It reads BACKEND_URL and INTERNAL_API_SECRET from the
// EXISTING backend/.env file at startup (parsed here, not via
// the `dotenv` package, so this tool needs zero dependencies).
// No new .env file is created, and the secret is only ever
// used server-side, in the proxy routes below — the browser
// never sees it.
//
// Every /dev-api/* route below is read-only. Nothing here
// writes to MongoDB, Qdrant, or Shopify.
// =========================================================

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.DEV_DASHBOARD_PORT || 3001);
const BACKEND_ENV_PATH = path.join(__dirname, "..", "backend", ".env");
const PUBLIC_DIR = path.join(__dirname, "public");

// =========================================================
// LOAD BACKEND CONFIG (read-only; never modifies the file)
// =========================================================

function loadBackendEnv(envPath) {
  const env = {};

  if (!fs.existsSync(envPath)) {
    return env;
  }

  const text = fs.readFileSync(envPath, "utf8");

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const eq = trimmed.indexOf("=");

    if (eq === -1) {
      continue;
    }

    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();

    if (key) {
      env[key] = value;
    }
  }

  return env;
}

const backendEnv = loadBackendEnv(BACKEND_ENV_PATH);

/*
 * backend/.env's own BACKEND_URL key is what the Shopify app
 * uses to reach the backend (which may be a tunnel URL in some
 * setups) — not necessarily where the backend actually listens
 * on this machine. Since this dashboard runs on the same
 * machine as the backend, it always talks to it over
 * localhost, using the backend's own PORT.
 */
const BACKEND_URL = `http://localhost:${backendEnv.PORT || 5000}`;
const INTERNAL_API_SECRET = backendEnv.INTERNAL_API_SECRET || "";

if (!INTERNAL_API_SECRET) {
  console.warn(
    "[DEV DASHBOARD] INTERNAL_API_SECRET was not found in backend/.env — " +
      "status/products/goal proxy calls will fail until it is set."
  );
}

// =========================================================
// BACKEND PROXY HELPERS
// =========================================================

async function callBackendInternal(pathAndQuery) {
  const url = `${BACKEND_URL}${pathAndQuery}`;

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "x-internal-api-secret": INTERNAL_API_SECRET
      }
    });

    const text = await response.text();
    let data;

    try {
      data = JSON.parse(text);
    } catch {
      data = { success: false, message: "Invalid backend response" };
    }

    return { status: response.status, data };
  } catch (error) {
    return {
      status: 502,
      data: { success: false, message: `Backend unreachable at ${BACKEND_URL}` }
    };
  }
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);

  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body)
  });

  res.end(body);
}

// =========================================================
// STATIC FILE SERVING
// =========================================================

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json"
};

function serveStatic(req, res, pathname) {
  const safePath = pathname === "/" ? "/index.html" : pathname;

  // Prevent path traversal outside the public/ directory.
  const resolved = path.normalize(path.join(PUBLIC_DIR, safePath));

  if (!resolved.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(resolved, (error, content) => {
    if (error) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }

    const ext = path.extname(resolved);

    res.writeHead(200, {
      "Content-Type": CONTENT_TYPES[ext] || "application/octet-stream"
    });
    res.end(content);
  });
}

// =========================================================
// ROUTES
// =========================================================

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === "/dev-api/status") {
    const shop = url.searchParams.get("shop");

    // Security fix: the backend now serves shop detail and the
    // cross-shop global overview from two separate routes, so a
    // regular merchant's own status call can never receive the
    // global, all-shop data. This dashboard is the one legitimate
    // caller of /global — it's still gated by INTERNAL_API_SECRET,
    // same as before, just a different path per case.
    const result = shop
      ? await callBackendInternal(`/api/internal/status?shop=${encodeURIComponent(shop)}`)
      : await callBackendInternal("/api/internal/status/global");

    return sendJson(res, result.status, result.data);
  }

  if (url.pathname === "/dev-api/products") {
    const params = new URLSearchParams();

    for (const key of ["shop", "page", "limit", "search"]) {
      const value = url.searchParams.get(key);
      if (value) params.set(key, value);
    }

    const result = await callBackendInternal(`/api/internal/goal/products?${params.toString()}`);
    return sendJson(res, result.status, result.data);
  }

  if (url.pathname === "/dev-api/goal") {
    const shop = url.searchParams.get("shop") || "";
    const result = await callBackendInternal(`/api/internal/goal?shop=${encodeURIComponent(shop)}`);
    return sendJson(res, result.status, result.data);
  }

  if (url.pathname === "/dev-api/search") {
    const shop = url.searchParams.get("shop") || "";
    const q = url.searchParams.get("q") || "";
    const mode = url.searchParams.get("mode") || "final";
    const params = new URLSearchParams({ shop, q, mode });

    // Security fix: /api/ai-search/search now requires
    // INTERNAL_API_SECRET, same as every other internal endpoint,
    // so this uses the authenticated helper instead of the plain
    // one.
    const result = await callBackendInternal(`/api/ai-search/search?${params.toString()}`);
    return sendJson(res, result.status, result.data);
  }

  if (url.pathname.startsWith("/dev-api/")) {
    return sendJson(res, 404, { success: false, message: "Unknown dev-api route" });
  }

  return serveStatic(req, res, url.pathname);
});

server.listen(PORT, () => {
  console.log(`[DEV DASHBOARD] Serving on http://localhost:${PORT}`);
  console.log(`[DEV DASHBOARD] Proxying to backend at ${BACKEND_URL}`);
});
