(() => {
  // ----------------------------
  // Premium Crypto App (CoinGecko)
  // ----------------------------
  const $ = (s) => document.querySelector(s);

  // UI
  const container = $("#container");
  const statusEl = $("#status");
  const refreshBtn = $("#refresh");
  const currencyEl = $("#currency");
  const coinSearchEl = $("#coinSearch");
  const suggestEl = $("#suggest");
  const addCoinBtn = $("#addCoinBtn");
  const chipsEl = $("#chips");
  const metaEl = $("#meta");
  const refreshIntervalEl = $("#refreshInterval");
  const toggleSparklinesBtn = $("#toggleSparklines");

  // Storage keys
  const LS = {
    watch: "cg_watchlist_v1",
    coins: "cg_coinlist_cache_v1",
    coinlist_time: "cg_coinlist_cache_time_v1",
    prices: (cur) => `cg_prices_cache_${cur}_v1`,
    prices_time: (cur) => `cg_prices_cache_${cur}_time_v1`,
    spark: (cur, id) => `cg_spark_${cur}_${id}_v1`,
    spark_time: (cur, id) => `cg_spark_${cur}_${id}_time_v1`,
    opts: "cg_opts_v1",
  };

  // Defaults
  const DEFAULT_WATCH = ["bitcoin", "ethereum", "tether", "litecoin", "cardano", "dogecoin"];
  const DEFAULT_OPTS = {
    currency: "usd",
    intervalMs: 30000,
    sparklines: true,
    pinned: {}, // id -> true
  };

  // Caching / TTL
  const TTL = {
    coinListMs: 1000 * 60 * 60 * 24 * 3, // 3 days
    pricesMs: 1000 * 20,                 // 20s cache for prices
    sparkMs: 1000 * 60 * 30,             // 30m cache for sparklines
  };

  // API
  const API = {
    coinList: "https://api.coingecko.com/api/v3/coins/list",
    simplePrice(ids, vs) {
      const qs = new URLSearchParams({
        ids: ids.join(","),
        vs_currencies: vs,
        include_24hr_change: "true",
        include_last_updated_at: "true",
      });
      return `https://api.coingecko.com/api/v3/simple/price?${qs.toString()}`;
    },
    coinMarkets(vs, ids) {
      // gets symbol + image + price + 24h change etc.
      const qs = new URLSearchParams({
        vs_currency: vs,
        ids: ids.join(","),
        order: "market_cap_desc",
        per_page: String(Math.min(250, ids.length || 1)),
        page: "1",
        sparkline: "false",
        price_change_percentage: "24h",
      });
      return `https://api.coingecko.com/api/v3/coins/markets?${qs.toString()}`;
    },
    marketChart(id, vs, days = 7) {
      const qs = new URLSearchParams({ vs_currency: vs, days: String(days) });
      return `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(id)}/market_chart?${qs.toString()}`;
    },
  };

  // State
  let opts = loadJSON(LS.opts, DEFAULT_OPTS);
  let watchlist = loadJSON(LS.watch, DEFAULT_WATCH);
  watchlist = uniq(watchlist).slice(0, 30); // soft limit
  let coinList = []; // [{id, symbol, name}]
  let selectedSuggestionId = null;
  let autoTimer = null;

  // ----------------------------
  // Utilities
  // ----------------------------
  function uniq(arr) {
    const seen = new Set();
    const out = [];
    for (const x of arr) {
      const v = String(x || "").trim();
      if (!v) continue;
      if (seen.has(v)) continue;
      seen.add(v);
      out.push(v);
    }
    return out;
  }

  function loadJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function saveJSON(key, val) {
    localStorage.setItem(key, JSON.stringify(val));
  }

  function setStatus(text, type = "info") {
    statusEl.textContent = text;
    statusEl.dataset.type = type;
  }

  function money(n, currencyCode) {
    if (!Number.isFinite(n)) return "—";
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currencyCode.toUpperCase(),
      maximumFractionDigits: n < 1 ? 6 : 2,
    }).format(n);
  }

  function pct(n) {
    if (!Number.isFinite(n)) return "—";
    const sign = n > 0 ? "+" : "";
    return `${sign}${n.toFixed(2)}%`;
  }

  function prettyName(nameOrId) {
    const s = String(nameOrId || "");
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : "—";
  }

  function isRateLimited(errText) {
    const t = (errText || "").toLowerCase();
    return t.includes("429") || t.includes("rate limit") || t.includes("too many requests");
  }

  // fetch with retry/backoff
  async function fetchJSON(url, { retries = 3, backoffMs = 650 } = {}) {
    let lastErr = null;
    for (let i = 0; i <= retries; i++) {
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          const msg = `HTTP ${res.status} ${text}`.trim();
          throw new Error(msg);
        }
        return await res.json();
      } catch (e) {
        lastErr = e;
        const msg = String(e?.message || e);
        const extra = isRateLimited(msg) ? 2.2 : 1.35;
        const wait = Math.round(backoffMs * Math.pow(extra, i));

        if (i < retries) await sleep(wait);
      }
    }
    throw lastErr;
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function setAutoInterval(ms) {
    if (autoTimer) clearInterval(autoTimer);
    autoTimer = null;

    if (!ms || ms <= 0) return;

    autoTimer = setInterval(() => {
      renderAll({ reason: "auto" });
    }, ms);
  }

  function persistAll() {
    saveJSON(LS.opts, opts);
    saveJSON(LS.watch, watchlist);
  }

  // ----------------------------
  // Coin list (search)
  // ----------------------------
  async function loadCoinList() {
    const cached = loadJSON(LS.coins, null);
    const cachedAt = Number(localStorage.getItem(LS.coinlist_time) || "0");
    const fresh = cached && Date.now() - cachedAt < TTL.coinListMs;

    if (fresh) {
      coinList = cached;
      return;
    }

    // fetch & cache
    const data = await fetchJSON(API.coinList, { retries: 3 });
    // data = [{id, symbol, name}]
    coinList = Array.isArray(data) ? data : [];
    saveJSON(LS.coins, coinList);
    localStorage.setItem(LS.coinlist_time, String(Date.now()));
  }

  function searchCoins(q) {
    const query = q.trim().toLowerCase();
    if (!query) return [];
    // fast search: startsWith first, then includes
    const starts = [];
    const contains = [];
    for (const c of coinList) {
      const name = (c.name || "").toLowerCase();
      const sym = (c.symbol || "").toLowerCase();
      const id = (c.id || "").toLowerCase();
      const hay = `${name} ${sym} ${id}`;

      if (name.startsWith(query) || sym.startsWith(query) || id.startsWith(query)) starts.push(c);
      else if (hay.includes(query)) contains.push(c);

      if (starts.length >= 8 && contains.length >= 8) break;
    }
    return [...starts, ...contains].slice(0, 10);
  }

  function showSuggestions(items) {
    if (!items.length) {
      suggestEl.classList.add("hide");
      suggestEl.innerHTML = "";
      selectedSuggestionId = null;
      return;
    }

    suggestEl.classList.remove("hide");
    suggestEl.innerHTML = items
      .map((c) => `
        <div class="suggest-item" data-id="${escapeHtml(c.id)}">
          <div class="suggest-left">
            <div class="suggest-name">${escapeHtml(c.name)}</div>
            <div class="suggest-id">${escapeHtml(c.symbol)} • ${escapeHtml(c.id)}</div>
          </div>
          <span class="pill" style="padding:6px 10px">Add</span>
        </div>
      `)
      .join("");

    suggestEl.querySelectorAll(".suggest-item").forEach((el) => {
      el.addEventListener("click", () => {
        const id = el.dataset.id;
        selectedSuggestionId = id;
        coinSearchEl.value = id; // put id for correctness
        suggestEl.classList.add("hide");
        suggestEl.innerHTML = "";
      });
    });
  }

  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (m) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[m]));
  }

  // ----------------------------
  // Prices + metadata
  // ----------------------------
  async function getMarketData(ids, vs) {
    // We use /coins/markets to get image+symbol
    // Cache it briefly per currency
    const cacheKey = LS.prices(vs);
    const timeKey = LS.prices_time(vs);

    const cached = loadJSON(cacheKey, null);
    const cachedAt = Number(localStorage.getItem(timeKey) || "0");
    if (cached && Date.now() - cachedAt < TTL.pricesMs) return cached;

    const url = API.coinMarkets(vs, ids);
    const data = await fetchJSON(url, { retries: 3, backoffMs: 700 });
    saveJSON(cacheKey, data);
    localStorage.setItem(timeKey, String(Date.now()));
    return data;
  }

  // ----------------------------
  // Sparklines (7d market chart)
  // ----------------------------
  async function getSparkline(id, vs) {
    const key = LS.spark(vs, id);
    const timeKey = LS.spark_time(vs, id);

    const cached = loadJSON(key, null);
    const cachedAt = Number(localStorage.getItem(timeKey) || "0");
    if (cached && Date.now() - cachedAt < TTL.sparkMs) return cached;

    const url = API.marketChart(id, vs, 7);
    const data = await fetchJSON(url, { retries: 2, backoffMs: 900 });

    // data.prices = [[ts, price], ...]
    const prices = Array.isArray(data?.prices) ? data.prices.map(p => Number(p?.[1])).filter(Number.isFinite) : [];
    saveJSON(key, prices);
    localStorage.setItem(timeKey, String(Date.now()));
    return prices;
  }

  function drawSpark(canvas, series) {
    if (!canvas) return;
    const c = canvas;
    const dpr = window.devicePixelRatio || 1;
    const cssW = c.clientWidth || 160;
    const cssH = c.clientHeight || 46;
    c.width = Math.round(cssW * dpr);
    c.height = Math.round(cssH * dpr);

    const ctx = c.getContext("2d");
    ctx.clearRect(0, 0, c.width, c.height);

    if (!series || series.length < 2) {
      // faint baseline
      ctx.globalAlpha = 0.35;
      ctx.strokeStyle = "#888";
      ctx.lineWidth = 2 * dpr;
      ctx.beginPath();
      ctx.moveTo(10 * dpr, (c.height / 2));
      ctx.lineTo(c.width - 10 * dpr, (c.height / 2));
      ctx.stroke();
      ctx.globalAlpha = 1;
      return;
    }

    const min = Math.min(...series);
    const max = Math.max(...series);
    const range = (max - min) || 1;

    // color by trend
    const up = series[series.length - 1] >= series[0];
    ctx.strokeStyle = up ? "#30ff20" : "#ff4d4d";
    ctx.lineWidth = 2 * dpr;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    const padX = 8 * dpr;
    const padY = 6 * dpr;
    const W = c.width - padX * 2;
    const H = c.height - padY * 2;

    ctx.beginPath();
    for (let i = 0; i < series.length; i++) {
      const x = padX + (i / (series.length - 1)) * W;
      const y = padY + (1 - ((series[i] - min) / range)) * H;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // faint fill
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineTo(padX + W, padY + H);
    ctx.lineTo(padX, padY + H);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // ----------------------------
  // Pinned ordering + chips
  // ----------------------------
  function isPinned(id) {
    return !!opts.pinned?.[id];
  }

  function togglePin(id) {
    opts.pinned = opts.pinned || {};
    if (opts.pinned[id]) delete opts.pinned[id];
    else opts.pinned[id] = true;
    persistAll();
    renderAll({ reason: "pin" });
  }

  function removeCoin(id) {
    watchlist = watchlist.filter(x => x !== id);
    // also remove pin state
    if (opts.pinned?.[id]) {
      delete opts.pinned[id];
    }
    persistAll();
    renderAll({ reason: "remove" });
  }

  function addCoinById(id) {
    const coinId = String(id || "").trim().toLowerCase();
    if (!coinId) return;

    if (watchlist.includes(coinId)) {
      setStatus("Already in watchlist", "info");
      return;
    }

    watchlist.unshift(coinId);
    watchlist = uniq(watchlist).slice(0, 30);
    persistAll();
    coinSearchEl.value = "";
    selectedSuggestionId = null;
    renderAll({ reason: "add" });
  }

  function renderChips() {
    chipsEl.innerHTML = "";

    if (!watchlist.length) {
      chipsEl.innerHTML = `<span class="small">No coins in watchlist. Add one above.</span>`;
      return;
    }

    const ordered = [...watchlist].sort((a, b) => {
      const pa = isPinned(a) ? 1 : 0;
      const pb = isPinned(b) ? 1 : 0;
      if (pa !== pb) return pb - pa; // pinned first
      return 0;
    });

    for (const id of ordered) {
      const el = document.createElement("div");
      el.className = "chip";
      el.innerHTML = `
        ${isPinned(id) ? `<span class="badge pin">PIN</span>` : ``}
        <b>${escapeHtml(id)}</b>
        <button title="Pin/Unpin">★</button>
        <button title="Remove">✕</button>
      `;

      const [pinBtn, delBtn] = el.querySelectorAll("button");
      pinBtn.addEventListener("click", () => togglePin(id));
      delBtn.addEventListener("click", () => removeCoin(id));

      chipsEl.appendChild(el);
    }
  }

  // ----------------------------
  // Render cards
  // ----------------------------
  function cardHTML(coin, cur) {
    const id = coin.id;
    const name = coin.name || prettyName(id);
    const sym = (coin.symbol || "").toUpperCase();

    const price = Number(coin.current_price);
    const ch = Number(coin.price_change_percentage_24h);
    const cls = Number.isFinite(ch) ? (ch >= 0 ? "up" : "down") : "neutral";

    return `
      <article class="card" data-id="${escapeHtml(id)}">
        <div class="logo">
          <img src="${escapeHtml(coin.image || "")}" alt="${escapeHtml(name)} logo" loading="lazy">
        </div>

        <div class="mid">
          <div class="nameRow">
            ${isPinned(id) ? `<span class="badge pin">Pinned</span>` : `<span class="badge">Coin</span>`}
            <div class="name">${escapeHtml(name)}</div>
            <div class="sym">${escapeHtml(sym)} • ${escapeHtml(id)}</div>
          </div>
          <div class="tags small">
            24h: <span class="change ${cls}">${escapeHtml(pct(ch))}</span>
          </div>
        </div>

        <div class="right">
          <div class="priceBlock">
            <div class="price">${escapeHtml(money(price, cur))}</div>
            <div class="small">Market cap rank: ${coin.market_cap_rank ?? "—"}</div>
          </div>

          <div class="sparkWrap ${opts.sparklines ? "" : "hideSpark"}">
            <canvas data-spark="1"></canvas>
          </div>

          <div class="actions">
            <button data-act="pin">${isPinned(id) ? "Unpin" : "Pin"}</button>
            <button data-act="remove">Remove</button>
          </div>
        </div>
      </article>
    `;
  }

  function setMetaText(extra = "") {
    const cur = opts.currency.toUpperCase();
    const pinCount = Object.keys(opts.pinned || {}).length;
    metaEl.textContent = `${watchlist.length} coins • pinned ${pinCount} • currency ${cur}${extra ? " • " + extra : ""}`;
  }

  // ----------------------------
  // Main render pipeline
  // ----------------------------
  async function renderAll({ reason = "manual" } = {}) {
    // update UI controls to reflect opts
    currencyEl.value = opts.currency;
    refreshIntervalEl.value = String(opts.intervalMs);
    toggleSparklinesBtn.textContent = `Sparklines: ${opts.sparklines ? "ON" : "OFF"}`;

    renderChips();
    setMetaText(reason === "auto" ? "auto refresh" : "");

    if (!watchlist.length) {
      container.innerHTML = `<div class="loading">Add coins to your watchlist above.</div>`;
      setStatus("Ready", "ok");
      return;
    }

    container.innerHTML = `<div class="loading">Fetching prices…</div>`;
    setStatus("Loading…", "info");

    try {
      // order watchlist with pinned first (stable)
      const ordered = [...watchlist].sort((a, b) => {
        const pa = isPinned(a) ? 1 : 0;
        const pb = isPinned(b) ? 1 : 0;
        if (pa !== pb) return pb - pa;
        return 0;
      });

      const data = await getMarketData(ordered, opts.currency);

      // data is an array of objects; build map for missing items
      const map = new Map((Array.isArray(data) ? data : []).map(x => [x.id, x]));

      const missing = ordered.filter(id => !map.has(id));
      if (missing.length) {
        // show warning but still render what we have
        setStatus(`Some coins not found: ${missing.slice(0,3).join(", ")}${missing.length>3?"…":""}`, "bad");
      } else {
        const time = new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
        setStatus(`Updated ${time}`, "ok");
      }

      // render cards in desired order (even if missing, render placeholder)
      container.innerHTML = ordered.map(id => {
        const coin = map.get(id);
        if (!coin) {
          return `
            <div class="errorBox">
              <b>${escapeHtml(id)}</b>
              <div class="small">Not returned by CoinGecko markets endpoint. Try a different id.</div>
              <div class="row" style="margin-top:10px">
                <button class="pill btn" data-fix-remove="${escapeHtml(id)}">Remove</button>
              </div>
            </div>
          `;
        }
        return cardHTML(coin, opts.currency);
      }).join("");

      // attach actions
      container.querySelectorAll("[data-act='pin']").forEach(btn => {
        btn.addEventListener("click", () => {
          const id = btn.closest(".card")?.dataset?.id;
          if (id) togglePin(id);
        });
      });

      container.querySelectorAll("[data-act='remove']").forEach(btn => {
        btn.addEventListener("click", () => {
          const id = btn.closest(".card")?.dataset?.id;
          if (id) removeCoin(id);
        });
      });

      container.querySelectorAll("[data-fix-remove]").forEach(btn => {
        btn.addEventListener("click", () => removeCoin(btn.dataset.fixRemove));
      });

      // sparklines
      if (opts.sparklines) {
        // fetch in a controlled way to avoid rate-limits:
        // sequential with small delay for > 6 coins.
        const cards = Array.from(container.querySelectorAll(".card"));
        for (let i = 0; i < cards.length; i++) {
          const card = cards[i];
          const id = card.dataset.id;
          const canvas = card.querySelector("canvas[data-spark='1']");
          if (!id || !canvas) continue;

          try {
            const series = await getSparkline(id, opts.currency);
            drawSpark(canvas, series);
          } catch {
            drawSpark(canvas, null);
          }

          // gentle spacing if many
          if (cards.length > 6) await sleep(180);
        }
      }
    } catch (err) {
      console.error(err);
      const msg = String(err?.message || err);

      const rate = isRateLimited(msg);
      setStatus(rate ? "Rate limited (try later)" : "Failed to load", "bad");

      container.innerHTML = `
        <div class="errorBox">
          <b>Couldn’t load prices.</b>
          <div class="small">${escapeHtml(rate ? "CoinGecko rate limit hit. Wait a bit, then Refresh." : "Network/API error. Try Refresh.")}</div>
          <div class="small" style="margin-top:8px">Tip: turn sparklines OFF if you track many coins.</div>
        </div>
      `;
    }
  }

  // ----------------------------
  // UI events
  // ----------------------------
  refreshBtn.addEventListener("click", () => renderAll({ reason: "manual" }));

  currencyEl.addEventListener("change", () => {
    opts.currency = currencyEl.value;
    persistAll();
    renderAll({ reason: "currency" });
  });

  refreshIntervalEl.addEventListener("change", () => {
    opts.intervalMs = Number(refreshIntervalEl.value);
    persistAll();
    setAutoInterval(opts.intervalMs);
    renderAll({ reason: "interval" });
  });

  toggleSparklinesBtn.addEventListener("click", () => {
    opts.sparklines = !opts.sparklines;
    persistAll();
    renderAll({ reason: "sparklines" });
  });

  addCoinBtn.addEventListener("click", () => {
    const id = selectedSuggestionId || coinSearchEl.value.trim().toLowerCase();
    addCoinById(id);
  });

  coinSearchEl.addEventListener("input", async () => {
    const q = coinSearchEl.value;
    selectedSuggestionId = null;

    if (!q.trim()) {
      suggestEl.classList.add("hide");
      suggestEl.innerHTML = "";
      return;
    }

    // ensure list ready (loaded once)
    if (!coinList.length) {
      try { await loadCoinList(); } catch { /* ignore */ }
    }

    const found = searchCoins(q);
    showSuggestions(found);
  });

  // click outside suggestions -> close
  document.addEventListener("click", (e) => {
    if (!suggestEl.contains(e.target) && e.target !== coinSearchEl) {
      suggestEl.classList.add("hide");
      suggestEl.innerHTML = "";
    }
  });

  // Enter to add
  coinSearchEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const id = selectedSuggestionId || coinSearchEl.value.trim().toLowerCase();
      addCoinById(id);
      suggestEl.classList.add("hide");
      suggestEl.innerHTML = "";
    }
  });

  // ----------------------------
  // Init
  // ----------------------------
  async function init() {
    // apply saved opts to UI
    currencyEl.value = opts.currency;
    refreshIntervalEl.value = String(opts.intervalMs);
    toggleSparklinesBtn.textContent = `Sparklines: ${opts.sparklines ? "ON" : "OFF"}`;

    // start interval
    setAutoInterval(opts.intervalMs);

    // coin list loads in background-ish (but still in this turn)
    try {
      setStatus("Loading coin list…", "info");
      await loadCoinList();
      setStatus("Ready", "ok");
    } catch {
      setStatus("Ready (coin search may be limited)", "info");
    }

    // first render
    renderAll({ reason: "init" });
  }

  init();
})();
