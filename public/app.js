// =========================================================
// DEVELOPER DASHBOARD — CLIENT
// =========================================================
//
// Plain vanilla JS, no framework, no build step. Every data
// call below goes through this same origin's /dev-api/* routes
// (server.js), which hold the backend's shared secret
// server-side. This file never talks to MongoDB or the backend
// directly, and never sees the secret.
// =========================================================

const state = {
  shops: [],
  products: { page: 1, limit: 25, hasMore: false, shop: "" }
};

// ---------------------------------------------------------
// TABS
// ---------------------------------------------------------

document.getElementById("tabs").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-tab]");
  if (!button) return;

  const tab = button.dataset.tab;

  document.querySelectorAll(".tab").forEach((el) => el.classList.toggle("active", el === button));
  document.querySelectorAll(".panel").forEach((el) =>
    el.classList.toggle("active", el.id === `panel-${tab}`)
  );
});

// ---------------------------------------------------------
// FETCH HELPER
// ---------------------------------------------------------

async function getJson(path) {
  const response = await fetch(path);
  const data = await response.json();
  return { ok: response.ok, status: response.status, data };
}

function badge(ok) {
  if (ok === true) return `<span class="badge ok">reachable</span>`;
  if (ok === false) return `<span class="badge bad">unreachable</span>`;
  return `<span class="badge unknown">unknown</span>`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

// ---------------------------------------------------------
// SHOP DROPDOWNS (shared across tabs)
// ---------------------------------------------------------

function populateShopSelects(shops) {
  const selects = [
    document.getElementById("products-shop"),
    document.getElementById("goals-shop"),
    document.getElementById("search-shop")
  ];

  const options = shops
    .map((s) => `<option value="${escapeHtml(s.shop)}">${escapeHtml(s.shop)} (${s.productCount})</option>`)
    .join("");

  selects.forEach((select) => {
    select.innerHTML = options || `<option value="">No shops synced yet</option>`;
  });
}

// ---------------------------------------------------------
// OVERVIEW + SYSTEM HEALTH (share one /dev-api/status call)
// ---------------------------------------------------------

async function loadOverviewAndHealth() {
  const { ok, data } = await getJson("/dev-api/status");

  if (!ok || !data?.success) {
    document.getElementById("overview-content").innerHTML =
      `<p class="error">${escapeHtml(data?.message || "Unable to load status")}</p>`;
    document.getElementById("health-content").innerHTML =
      `<p class="error">${escapeHtml(data?.message || "Unable to load status")}</p>`;
    return;
  }

  const g = data.data.global;
  state.shops = g.shops || [];
  populateShopSelects(state.shops);

  document.getElementById("overview-content").innerHTML = `
    <div class="card"><div class="label">Backend health</div><div class="value">${badge(true)}</div></div>
    <div class="card"><div class="label">MongoDB</div><div class="value">${badge(g.mongo.connected)}</div></div>
    <div class="card"><div class="label">Total products (all shops)</div><div class="value">${g.products.total}</div></div>
    <div class="card"><div class="label">Available</div><div class="value">${g.products.available}</div></div>
    <div class="card"><div class="label">Unavailable</div><div class="value">${g.products.unavailable}</div></div>
    <div class="card"><div class="label">Total goals/rules</div><div class="value">${g.goals.total}</div></div>
    <div class="card"><div class="label">Qdrant</div><div class="value">${badge(g.qdrant.reachable)}</div></div>
    <div class="card"><div class="label">Embedding service</div><div class="value">${badge(g.embeddingService.reachable)}</div></div>
  `;

  document.getElementById("health-content").innerHTML = `
    <table>
      <thead><tr><th>Component</th><th>Status</th><th>Detail</th></tr></thead>
      <tbody>
        <tr><td>Backend API</td><td>${badge(true)}</td><td>responded to /api/internal/status</td></tr>
        <tr><td>MongoDB connection</td><td>${badge(g.mongo.connected)}</td><td>${escapeHtml(g.mongo.state)}</td></tr>
        <tr><td>Qdrant connection</td><td>${badge(g.qdrant.reachable)}</td><td>collection "${escapeHtml(g.qdrant.collection)}"${g.qdrant.pointsCount != null ? `, ${g.qdrant.pointsCount} points` : ""}</td></tr>
        <tr><td>Embedding service (Qwen/Ollama local)</td><td>${badge(g.embeddingService.reachable)}</td><td>${escapeHtml(g.embeddingService.model || "not configured")}</td></tr>
        <tr><td>LLM service (GLM/Ollama cloud)</td><td>${badge(g.llmService.reachable)}</td><td>${escapeHtml(g.llmService.model || "not configured")}</td></tr>
      </tbody>
    </table>
    <p class="muted">Reachability checks use short timeouts and never trigger a real embedding/chat generation call. A timeout or network hiccup is reported as "unknown", not a confident "down".</p>
  `;

  await loadSyncStatus();
}

// ---------------------------------------------------------
// SYNCHRONIZATION STATUS
// ---------------------------------------------------------

async function loadSyncStatus() {
  const container = document.getElementById("sync-content");

  if (!state.shops.length) {
    container.innerHTML = `<p class="muted">No shops have synced products yet.</p>`;
    return;
  }

  const rows = await Promise.all(
    state.shops.map(async (s) => {
      const { ok, data } = await getJson(`/dev-api/status?shop=${encodeURIComponent(s.shop)}`);
      const shopStatus = ok && data?.success ? data.data.shop : null;

      return { shop: s.shop, productCount: s.productCount, shopStatus };
    })
  );

  container.innerHTML = `
    <table>
      <thead><tr><th>Shop</th><th>Products</th><th>Available</th><th>Last synced</th></tr></thead>
      <tbody>
        ${rows.map((r) => `
          <tr>
            <td>${escapeHtml(r.shop)}</td>
            <td>${r.productCount}</td>
            <td>${r.shopStatus ? r.shopStatus.products.available : "—"}</td>
            <td>${r.shopStatus?.lastSyncedAt ? new Date(r.shopStatus.lastSyncedAt).toLocaleString() : "Never"}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

// ---------------------------------------------------------
// PRODUCTS DB VIEWER
// ---------------------------------------------------------

async function loadProducts(page = 1) {
  const shop = document.getElementById("products-shop").value;
  const search = document.getElementById("products-search").value.trim();
  const wrap = document.getElementById("products-table-wrap");

  if (!shop) {
    wrap.innerHTML = `<p class="muted">Select a shop above.</p>`;
    return;
  }

  wrap.innerHTML = `<p class="muted">Loading…</p>`;

  const params = new URLSearchParams({ shop, page: String(page), limit: "20" });
  if (search) params.set("search", search);

  const { ok, data } = await getJson(`/dev-api/products?${params.toString()}`);

  if (!ok || !data?.success) {
    wrap.innerHTML = `<p class="error">${escapeHtml(data?.message || "Unable to load products")}</p>`;
    return;
  }

  const products = data.data.products;
  state.products = { page: data.data.page, limit: data.data.limit, hasMore: data.data.hasMore, shop };

  if (!products.length) {
    wrap.innerHTML = `<p class="muted">No products found.</p>`;
  } else {
    wrap.innerHTML = `
      <table>
        <thead>
          <tr><th></th><th>SKU</th><th>Title</th><th>Handle</th><th>Price</th><th>Availability</th><th>Updated</th></tr>
        </thead>
        <tbody>
          ${products.map((p) => `
            <tr>
              <td>${p.image ? `<img class="thumb" src="${escapeHtml(p.image)}" alt="" />` : ""}</td>
              <td>${escapeHtml(p.sku)}</td>
              <td>${escapeHtml(p.title)}</td>
              <td>${escapeHtml(p.handle)}</td>
              <td>${typeof p.price === "number" ? `$${p.price.toFixed(2)}` : "—"}</td>
              <td>${badge(p.availableForSale)}</td>
              <td>${p.updatedAt ? new Date(p.updatedAt).toLocaleDateString() : "—"}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    `;
  }

  document.getElementById("products-page-label").textContent = `Page ${state.products.page}`;
  document.getElementById("products-prev").disabled = state.products.page <= 1;
  document.getElementById("products-next").disabled = !state.products.hasMore;
}

document.getElementById("products-shop").addEventListener("change", () => loadProducts(1));
document.getElementById("products-search-btn").addEventListener("click", () => loadProducts(1));
document.getElementById("products-search").addEventListener("keydown", (e) => {
  if (e.key === "Enter") loadProducts(1);
});
document.getElementById("products-prev").addEventListener("click", () =>
  loadProducts(Math.max(1, state.products.page - 1))
);
document.getElementById("products-next").addEventListener("click", () => {
  if (state.products.hasMore) loadProducts(state.products.page + 1);
});

// ---------------------------------------------------------
// GOALS & RULES
// ---------------------------------------------------------

async function loadGoal() {
  const shop = document.getElementById("goals-shop").value;
  const container = document.getElementById("goals-content");

  if (!shop) {
    container.innerHTML = `<p class="muted">Select a shop above.</p>`;
    return;
  }

  container.innerHTML = `<p class="muted">Loading…</p>`;

  const { ok, data } = await getJson(`/dev-api/goal?shop=${encodeURIComponent(shop)}`);

  if (!ok || !data?.success) {
    container.innerHTML = `<p class="error">${escapeHtml(data?.message || "Unable to load goal")}</p>`;
    return;
  }

  const goal = data.data;

  if (!goal) {
    container.innerHTML = `<p class="muted">No goal/rule saved for this shop.</p>`;
    return;
  }

  container.innerHTML = `
    <div class="rule-card">
      <div class="row"><strong>Shop</strong><span>${escapeHtml(goal.shop)}</span></div>
      <div class="row"><strong>Rule name</strong><span>${escapeHtml(goal.name)}</span></div>
      <div class="row"><strong>Rule type</strong><span>${escapeHtml(goal.ruleType || "not set")}</span></div>
      <div class="row"><strong>Enabled</strong><span>${goal.enabled ? "Yes" : "No"}</span></div>
      <div class="row"><strong>Selected SKUs</strong><span>${(goal.skus || []).length}</span></div>
      <div class="row"><strong>Created</strong><span>${new Date(goal.createdAt).toLocaleString()}</span></div>
      <div class="row"><strong>Updated</strong><span>${new Date(goal.updatedAt).toLocaleString()}</span></div>
    </div>
    <p class="muted" style="margin-top:10px">SKUs: ${(goal.skus || []).map(escapeHtml).join(", ") || "none"}</p>
  `;
}

document.getElementById("goals-shop").addEventListener("change", loadGoal);

// ---------------------------------------------------------
// SEARCH DEBUGGER
// ---------------------------------------------------------

async function runSearchDebug() {
  const shop = document.getElementById("search-shop").value;
  const q = document.getElementById("search-query").value.trim();
  const mode = document.getElementById("search-mode").value;
  const container = document.getElementById("search-results");

  if (!shop || !q) {
    container.innerHTML = `<p class="muted">Select a shop and enter a query.</p>`;
    return;
  }

  container.innerHTML = `<p class="muted">Searching…</p>`;

  const params = new URLSearchParams({ shop, q, mode });
  const { ok, data } = await getJson(`/dev-api/search?${params.toString()}`);

  if (!ok || !data?.success) {
    container.innerHTML = `<p class="error">${escapeHtml(data?.message || "Search failed")}</p>`;
    return;
  }

  const products = data.products || [];

  container.innerHTML = `
    <p><strong>Intent:</strong> ${escapeHtml(data.intent || "—")} &nbsp; <strong>Result type:</strong> ${escapeHtml(data.resultType || "—")}</p>
    ${data.message ? `<p class="muted">${escapeHtml(data.message)}</p>` : ""}
    ${products.length === 0
      ? `<p class="muted">No products returned.</p>`
      : products.map((p, i) => `
          <div class="result-item">
            <strong>#${i + 1}</strong> ${escapeHtml(p.title)} — SKU ${escapeHtml(p.sku)}
            ${typeof p.recommendationScore === "number" ? ` (score ${p.recommendationScore})` : ""}
          </div>
        `).join("")
    }
  `;
}

document.getElementById("search-run").addEventListener("click", runSearchDebug);
document.getElementById("search-query").addEventListener("keydown", (e) => {
  if (e.key === "Enter") runSearchDebug();
});

// ---------------------------------------------------------
// INIT
// ---------------------------------------------------------

loadOverviewAndHealth();
