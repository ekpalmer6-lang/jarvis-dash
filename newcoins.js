/* New Coins live board for the JARVIS dashboard.
   Public sources only (no keys). Scores use real fields or show "—". */
(function () {
  "use strict";

  const WS_URL = "wss://pumpportal.fun/api/data";
  const DEX_TOKENS = "https://api.dexscreener.com/tokens/v1/solana/";
  const DEX_SOL = "https://api.dexscreener.com/tokens/v1/solana/So11111111111111111111111111111111111111112";
  const GT_NEW = "https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=1&include=base_token,quote_token,dex";
  const WSOL = "So11111111111111111111111111111111111111112";
  const TZ = "Australia/Perth";
  const MAX = 100;
  const TRADE_SUB_N = 30;
  const DEX_POLL_MS = 8000;
  const GT_POLL_MS = 45000;
  const JARVIS_POLL_MS = 30000;
  const SNAP_POLL_MS = 12000;
  const CURVE_START = 30;
  const CURVE_SPAN = 85;
  const HIGH_RISK = 70;

  const coins = new Map();
  const state = {
    ws: "off",
    lastEvent: 0,
    lastDex: 0,
    solUsd: null,
    hideHighRisk: false,
    sortByReward: false,
    openMint: null,
    tradeKeys: [],
    reconnectTimer: 0
  };
  let ws = null;
  let ageTimer = 0;

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function num(v) {
    if (v == null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
  function isoNow() { return new Date().toISOString(); }
  function awst(t) {
    if (!t) return "—";
    const d = (typeof t === "number") ? new Date(t) : new Date(t);
    if (isNaN(d)) return "—";
    return d.toLocaleString("en-US", {
      timeZone: TZ, hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true
    }) + " AWST";
  }
  function ageText(ts) {
    if (!ts) return "—";
    const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (s < 60) return s + "s";
    const m = Math.floor(s / 60);
    if (m < 60) return m + "m " + String(s % 60).padStart(2, "0") + "s";
    const h = Math.floor(m / 60);
    return h + "h " + (m % 60) + "m";
  }
  function kfmt(v) {
    if (v == null || !Number.isFinite(v)) return "—";
    const a = Math.abs(v);
    if (a >= 1e6) return "$" + (v / 1e6).toFixed(2) + "M";
    if (a >= 1e3) return "$" + (v / 1e3).toFixed(1) + "k";
    if (a >= 10) return "$" + Math.round(v);
    return "$" + v.toFixed(2);
  }
  function safeImg(url) {
    if (!url || typeof url !== "string") return null;
    try {
      const u = new URL(url);
      if (u.protocol === "https:" || u.protocol === "http:") return u.href;
    } catch (e) {}
    return null;
  }
  function isMint(s) {
    return typeof s === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
  }
  function curvePct(vsol, migrated) {
    if (migrated) return 100;
    const v = num(vsol);
    if (v == null) return null;
    return clamp((v - CURVE_START) / CURVE_SPAN * 100, 0, 100);
  }
  function mcapUsd(c) {
    if (c.mcUsd != null) return c.mcUsd;
    if (c.marketCapSol != null && state.solUsd != null) return c.marketCapSol * state.solUsd;
    return null;
  }

  /* ---------- scoring: only real fields; otherwise null ("—") ---------- */
  function band(x, steps) {
    // steps: [[threshold, score], ...] ascending thresholds, last is default
    for (let i = 0; i < steps.length - 1; i++) {
      if (x < steps[i][0]) return steps[i][1];
    }
    return steps[steps.length - 1][1];
  }
  function authPresent(v) {
    if (v == null) return null;
    if (v === false || v === 0 || v === "0" || v === "false" || v === "") return false;
    if (v === true || v === 1 || v === "1" || v === "true") return true;
    if (typeof v === "string" && v.length >= 32) return true;
    return null;
  }
  function weighted(parts) {
    // parts: [{label, score, weight, detail}]
    const used = parts.filter(p => p.score != null && Number.isFinite(p.score));
    if (used.length < 2) return { value: null, parts: parts };
    let nume = 0, den = 0;
    used.forEach(p => { nume += p.score * p.weight; den += p.weight; });
    return { value: Math.round(clamp(nume / den, 0, 100)), parts: parts };
  }
  function scoreRisk(c) {
    const ageS = c.createdAt ? (Date.now() - c.createdAt) / 1000 : null;
    const mintA = authPresent(c.mintAuth);
    const freezeA = authPresent(c.freezeAuth);
    let authScore = null, authDetail = "unknown";
    if (mintA != null || freezeA != null) {
      const open = mintA === true || freezeA === true;
      const closed = mintA === false && freezeA === false;
      if (open) { authScore = 100; authDetail = "mint or freeze authority still open"; }
      else if (closed) { authScore = 10; authDetail = "mint and freeze closed"; }
      else if (mintA === true) { authScore = 90; authDetail = "mint authority open"; }
      else if (freezeA === true) { authScore = 90; authDetail = "freeze authority open"; }
    }
    const liq = c.liqUsd != null ? c.liqUsd : (c.vSol != null && state.solUsd && !c.migrated
      ? Math.max(0, (c.vSol - CURVE_START) * state.solUsd) : null);
    const buys = num(c.buys5m), sells = num(c.sells5m);
    const tx = (buys || 0) + (sells || 0);
    const buyRatio = (buys != null && sells != null && tx >= 5) ? buys / tx : (c.buyRatio5m != null && tx >= 5 ? c.buyRatio5m : null);
    const parts = [
      { id: "age", label: "Age", weight: 1.0, score: ageS == null ? null : band(ageS, [[30, 90], [120, 80], [600, 65], [1800, 50], [7200, 35], [21600, 25], [Infinity, 15]]), detail: ageS == null ? "unknown" : ageText(c.createdAt) },
      { id: "auth", label: "Mint / freeze authority", weight: 1.5, score: authScore, detail: authDetail },
      { id: "dev", label: "Dev holdings", weight: 1.5, score: c.devPct == null ? null : band(c.devPct, [[2, 15], [5, 40], [10, 70], [Infinity, 95]]), detail: c.devPct == null ? "unknown" : c.devPct.toFixed(1) + "%" },
      { id: "top10", label: "Top-10 concentration", weight: 1.2, score: c.top10Pct == null ? null : band(c.top10Pct, [[20, 15], [35, 40], [50, 70], [Infinity, 95]]), detail: c.top10Pct == null ? "unknown" : c.top10Pct.toFixed(1) + "%" },
      { id: "liq", label: "Liquidity", weight: 1.0, score: liq == null ? null : band(liq, [[1000, 90], [5000, 75], [15000, 55], [50000, 35], [Infinity, 15]]), detail: liq == null ? "unknown" : kfmt(liq) },
      { id: "sniper", label: "Sniper share", weight: 1.2, score: c.sniperPct == null ? null : band(c.sniperPct, [[5, 15], [15, 45], [30, 75], [Infinity, 95]]), detail: c.sniperPct == null ? "unknown" : c.sniperPct.toFixed(1) + "%" },
      { id: "sells", label: "Sell pressure (5m)", weight: 1.0, score: buyRatio == null ? null : band(1 - buyRatio, [[0.30, 15], [0.50, 40], [0.70, 70], [Infinity, 90]]), detail: buyRatio == null ? "unknown" : Math.round(buyRatio * 100) + "% buys" },
      { id: "lp", label: "LP lock", weight: 1.0, score: c.lpLockedPct == null ? null : (c.lpLockedPct >= 90 ? 10 : c.lpLockedPct >= 80 ? 25 : c.lpLockedPct >= 50 ? 60 : 90), detail: c.lpLockedPct == null ? "unknown" : c.lpLockedPct.toFixed(0) + "% locked" }
    ];
    const out = weighted(parts);
    if (c.rugged || c.rugFlag) {
      out.value = out.value == null ? 100 : Math.max(out.value, 95);
      out.parts.push({ id: "rug", label: "Rug flag", weight: 0, score: 100, detail: "flagged rugged or rug-like" });
    }
    return out;
  }
  function scoreReward(c) {
    const buys = num(c.buys5m), sells = num(c.sells5m);
    const tx = (buys || 0) + (sells || 0);
    const buyRatio = (buys != null && sells != null && tx >= 5) ? buys / tx : (c.buyRatio5m != null && tx >= 5 ? c.buyRatio5m : null);
    const mc = mcapUsd(c);
    const volMc = (c.vol5m != null && mc && mc > 0) ? c.vol5m / mc : null;
    const buyers = c.uniqueBuyers15m != null ? c.uniqueBuyers15m : c.uniqueBuyers5m;
    const curve = c.curvePct;
    let curveScore = null, curveDetail = "unknown";
    if (curve != null) {
      curveDetail = curve.toFixed(1) + "% of curve";
      if (c.migrated || curve >= 100) { curveScore = 50; curveDetail = "migrated / 100%"; }
      else if (curve < 10) curveScore = 25;
      else if (curve < 40) curveScore = 70;
      else if (curve < 70) curveScore = 60;
      else if (curve < 90) curveScore = 45;
      else curveScore = 55;
    }
    let buzzScore = null, buzzDetail = "unknown";
    const src = (c.buzzSources || "").toString().toLowerCase();
    if (src) {
      const hits = ["telegram", "reddit", "twitter", "x.com", "feed_telegram", "feed_reddit", "feed_x"].filter(k => src.includes(k) || (c.sourcesList || []).some(s => String(s).toLowerCase().includes(k)));
      const n = new Set(hits.map(h => h.includes("telegram") ? "tg" : h.includes("reddit") ? "rd" : "x")).size;
      if (n >= 3) buzzScore = 80;
      else if (n === 2) buzzScore = 60;
      else if (n === 1) buzzScore = 40;
      buzzDetail = n ? n + " buzz source" + (n > 1 ? "s" : "") : "no social buzz recorded";
      if (!n) { buzzScore = null; buzzDetail = "no social buzz recorded"; }
    }
    const parts = [
      { id: "mom", label: "Momentum (5m)", weight: 1.2, score: c.chg5m == null ? null : (c.chg5m > 40 ? 90 : c.chg5m > 20 ? 75 : c.chg5m > 10 ? 60 : c.chg5m > 0 ? 45 : c.chg5m > -10 ? 25 : 10), detail: c.chg5m == null ? "unknown" : (c.chg5m >= 0 ? "+" : "") + c.chg5m.toFixed(1) + "%" },
      { id: "flow", label: "Buy / sell ratio (5m)", weight: 1.3, score: buyRatio == null ? null : (buyRatio > 0.8 ? 90 : buyRatio > 0.65 ? 70 : buyRatio > 0.5 ? 45 : 20), detail: buyRatio == null ? "unknown" : Math.round(buyRatio * 100) + "% buys (" + (buys || 0) + "/" + (sells || 0) + ")" },
      { id: "buyers", label: "Unique buyers", weight: 1.0, score: buyers == null ? null : band(buyers, [[10, 20], [20, 35], [40, 50], [80, 70], [Infinity, 85]]), detail: buyers == null ? "unknown" : String(buyers) },
      { id: "volmc", label: "Volume / market cap (5m)", weight: 1.1, score: volMc == null ? null : band(volMc, [[0.02, 15], [0.05, 35], [0.15, 55], [0.30, 75], [Infinity, 90]]), detail: volMc == null ? "unknown" : (volMc * 100).toFixed(1) + "%" },
      { id: "curve", label: "Bonding curve progress", weight: 0.8, score: curveScore, detail: curveDetail },
      { id: "buzz", label: "Buzz (Jarvis feeds)", weight: 0.8, score: buzzScore, detail: buzzDetail }
    ];
    return weighted(parts);
  }
  function rescore(c) {
    const r = scoreRisk(c), w = scoreReward(c);
    c.risk = r.value;
    c.reward = w.value;
    c.riskParts = r.parts;
    c.rewardParts = w.parts;
  }

  /* ---------- coin upsert ---------- */
  function get(mint, create) {
    let c = coins.get(mint);
    if (!c) {
      if (create === false) return null;
      c = { mint, createdAt: null, firstSource: null };
      coins.set(mint, c);
    }
    return c;
  }
  function applyCreate(msg, source, receivedAt) {
    const mint = msg.mint || msg.tokenAddress;
    if (!isMint(mint) || mint === WSOL) return null;
    const c = get(mint);
    const ts = receivedAt || Date.now();
    if (!c.firstSource) c.firstSource = source;
    if (!c.createdAt || ts < c.createdAt) c.createdAt = ts;
    if (msg.name) c.name = String(msg.name).slice(0, 64);
    if (msg.symbol) c.symbol = String(msg.symbol).slice(0, 24);
    if (msg.uri) c.uri = String(msg.uri).slice(0, 240);
    if (msg.image) { const im = safeImg(msg.image); if (im) c.image = im; }
    if (msg.pool) c.pool = msg.pool;
    if (msg.is_mayhem_mode) c.mayhem = true;
    if (msg.migrated || msg.txType === "migration") c.migrated = true;
    const vsol = num(msg.vSolInBondingCurve);
    if (vsol != null) c.vSol = vsol;
    const mcs = num(msg.marketCapSol);
    if (mcs != null) c.marketCapSol = mcs;
    if (msg.curve_pct != null) c.curvePct = num(msg.curve_pct);
    else c.curvePct = curvePct(c.vSol, c.migrated);
    c.updatedAt = Date.now();
    rescore(c);
    return c;
  }
  function applyDex(pair) {
    if (!pair || pair.chainId && pair.chainId !== "solana") return;
    const base = pair.baseToken || {};
    const quote = pair.quoteToken || {};
    let mint = base.address, name = base.name, symbol = base.symbol;
    if (mint === WSOL && isMint(quote.address)) {
      mint = quote.address; name = quote.name; symbol = quote.symbol;
    }
    if (!isMint(mint) || mint === WSOL) return;
    const c = get(mint);
    if (!c.firstSource) c.firstSource = "dexscreener";
    if (name) c.name = c.name || name;
    if (symbol) c.symbol = c.symbol || symbol;
    const img = safeImg((pair.info && pair.info.imageUrl) || (pair.info && pair.info.header) || null);
    if (img) c.image = img;
    const liq = num(pair.liquidity && pair.liquidity.usd);
    const mc = num(pair.marketCap != null ? pair.marketCap : pair.fdv);
    const chg = num(pair.priceChange && pair.priceChange.m5);
    const vol = num(pair.volume && pair.volume.m5);
    const tx = pair.txns && pair.txns.m5 || {};
    const buys = num(tx.buys), sells = num(tx.sells);
    const created = num(pair.pairCreatedAt);
    if (liq != null) c.liqUsd = c.liqUsd == null ? liq : Math.max(c.liqUsd, liq);
    if (mc != null) c.mcUsd = mc;
    if (chg != null) c.chg5m = chg;
    if (vol != null) c.vol5m = vol;
    if (buys != null) c.buys5m = buys;
    if (sells != null) c.sells5m = sells;
    if (pair.url) c.dexUrl = pair.url;
    if (pair.pairAddress) c.pair = pair.pairAddress;
    if (pair.dexId) c.dex = pair.dexId;
    if (created) {
      // DexScreener pairCreatedAt is ms
      const ts = created < 1e12 ? created * 1000 : created;
      if (!c.createdAt || ts < c.createdAt) c.createdAt = ts;
    }
    const dex = String(pair.dexId || "").toLowerCase();
    if (dex === "pumpswap" || dex === "raydium" || dex === "orca" || dex === "meteora") {
      if (c.pool === "pump" || /pump/.test(c.mint) || c.vSol != null) {
        c.migrated = true;
        c.curvePct = 100;
      }
    } else if (dex === "pumpfun" || dex === "pump.fun" || dex === "pump-fun") {
      c.pool = c.pool || "pump";
    }
    c.dexAt = Date.now();
    c.updatedAt = Date.now();
    rescore(c);
  }
  function applyGtPool(pool, tokensById) {
    const attrs = pool.attributes || {};
    const rel = pool.relationships || {};
    const baseId = rel.base_token && rel.base_token.data && rel.base_token.data.id;
    const quoteId = rel.quote_token && rel.quote_token.data && rel.quote_token.data.id;
    const dexId = rel.dex && rel.dex.data && rel.dex.data.id;
    const baseTok = tokensById[baseId] || {};
    const quoteTok = tokensById[quoteId] || {};
    let mint = baseTok.address || (baseId && String(baseId).split("solana_")[1]);
    let name = baseTok.name, symbol = baseTok.symbol, image = baseTok.image_url;
    if (mint === WSOL) {
      mint = quoteTok.address || (quoteId && String(quoteId).split("solana_")[1]);
      name = quoteTok.name; symbol = quoteTok.symbol; image = quoteTok.image_url;
    }
    if (!isMint(mint) || mint === WSOL) return;
    const created = attrs.pool_created_at ? Date.parse(attrs.pool_created_at) : NaN;
    const c = get(mint);
    if (!c.firstSource) c.firstSource = "geckoterminal";
    if (name) c.name = c.name || name;
    if (symbol) c.symbol = c.symbol || symbol;
    const im = safeImg(image);
    if (im) c.image = c.image || im;
    if (!isNaN(created) && (!c.createdAt || created < c.createdAt)) c.createdAt = created;
    const mc = num(attrs.market_cap_usd != null ? attrs.market_cap_usd : attrs.fdv_usd);
    if (mc != null && c.mcUsd == null) c.mcUsd = mc;
    const chg = num(attrs.price_change_percentage && attrs.price_change_percentage.m5);
    if (chg != null && c.chg5m == null) c.chg5m = chg;
    const vol = num(attrs.volume_usd && attrs.volume_usd.m5);
    if (vol != null && c.vol5m == null) c.vol5m = vol;
    const tx = attrs.transactions && attrs.transactions.m5 || {};
    if (c.buys5m == null && tx.buys != null) c.buys5m = num(tx.buys);
    if (c.sells5m == null && tx.sells != null) c.sells5m = num(tx.sells);
    if (c.uniqueBuyers5m == null && tx.buyers != null) c.uniqueBuyers5m = num(tx.buyers);
    const liq = num(attrs.reserve_in_usd);
    if (liq != null && c.liqUsd == null) c.liqUsd = liq;
    if (attrs.address) c.pair = c.pair || attrs.address;
    if (dexId) c.dex = c.dex || dexId;
    if (String(dexId || "").toLowerCase().indexOf("pump") >= 0) c.pool = c.pool || "pump";
    c.updatedAt = Date.now();
    rescore(c);
  }
  function applyJarvisRow(row) {
    if (!row || !isMint(row.mint)) return;
    // Decorate launches already on the board; do not inject older scan rows as 'new'.
    const c = get(row.mint, false);
    if (!c) return;
    c.jarvis = true;
    c.jarvisAt = Date.now();
    if (row.confidence != null) c.confidence = num(row.confidence);
    if (row.verdict) c.jarvisVerdict = String(row.verdict);
    if (row.sources) c.buzzSources = String(row.sources);
    if (Array.isArray(row.socials)) c.sourcesList = row.socials;
    if (row.name) c.name = c.name || row.name;
    if (row.symbol) c.symbol = c.symbol || row.symbol;
    if (row.dev_pct != null) c.devPct = num(row.dev_pct);
    if (row.top10_pct != null) c.top10Pct = num(row.top10_pct);
    if (row.lp_locked_pct != null) c.lpLockedPct = num(row.lp_locked_pct);
    if (row.sniper_pct != null) c.sniperPct = num(row.sniper_pct);
    if ("mint_auth" in row) c.mintAuth = row.mint_auth;
    if ("freeze_auth" in row) c.freezeAuth = row.freeze_auth;
    if (row.liq_usd != null) c.liqUsd = num(row.liq_usd);
    if (row.mc_usd != null) c.mcUsd = num(row.mc_usd);
    if (row.holders != null) c.holders = num(row.holders);
    if (row.buy_ratio5m != null) c.buyRatio5m = num(row.buy_ratio5m);
    if (row.buys5m != null) c.buys5m = num(row.buys5m);
    if (row.sells5m != null) c.sells5m = num(row.sells5m);
    if (row.vol5m != null) c.vol5m = num(row.vol5m);
    if (row.chg5m != null) c.chg5m = num(row.chg5m);
    if (row.flow_15m_unique_buyers != null) c.uniqueBuyers15m = num(row.flow_15m_unique_buyers);
    if (row.flow_5m_unique_buyers != null) c.uniqueBuyers5m = num(row.flow_5m_unique_buyers);
    if (row.rug_flag || row.rugged) { c.rugFlag = !!row.rug_flag; c.rugged = !!row.rugged; }
    if (row.url) c.dexUrl = c.dexUrl || row.url;
    if (row.pair) c.pair = c.pair || row.pair;
    c.updatedAt = Date.now();
    rescore(c);
  }
  function applyChecklist(mint, doc) {
    if (!doc || !isMint(mint)) return;
    const c = get(mint, false);
    if (!c) return;
    c.jarvis = true;
    if (doc.confidence != null && c.confidence == null) c.confidence = num(doc.confidence);
    if (doc.verdict) c.jarvisNote = String(doc.verdict).slice(0, 240);
    if (doc.scan_verdict) c.jarvisVerdict = c.jarvisVerdict || String(doc.scan_verdict);
    rescore(c);
  }

  function trimMap() {
    if (coins.size <= MAX) return;
    const arr = [...coins.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const keep = new Set(arr.slice(0, MAX).map(c => c.mint));
    for (const k of coins.keys()) if (!keep.has(k)) coins.delete(k);
  }

  /* ---------- render ---------- */
  function pctChip(kind, value) {
    if (value == null) return `<span class="nc-pct unk">${esc(kind)} —</span>`;
    const cls = kind === "Risk"
      ? (value < 40 ? "ok" : value < HIGH_RISK ? "mid" : "bad")
      : (value < 40 ? "dim" : value < 70 ? "mid" : "ok");
    return `<span class="nc-pct ${cls}">${esc(kind)} ${value}%</span>`;
  }
  function partsHtml(title, parts, value) {
    const rows = (parts || []).map(p => {
      const sc = p.score == null ? "—" : Math.round(p.score) + "%";
      return `<div class="nc-part"><span>${esc(p.label)}</span><b class="mono">${esc(sc)}</b><i>${esc(p.detail || "")}</i></div>`;
    }).join("");
    const head = value == null ? "— (not enough known factors)" : value + "%";
    return `<div class="nc-break"><div class="nc-break-h">${esc(title)} · ${esc(head)}</div>${rows}</div>`;
  }
  function visibleList() {
    let arr = [...coins.values()];
    if (state.hideHighRisk) arr = arr.filter(c => c.risk == null || c.risk < HIGH_RISK);
    if (state.sortByReward) {
      arr.sort((a, b) => {
        const ar = a.reward, br = b.reward;
        if (ar == null && br == null) return (b.createdAt || 0) - (a.createdAt || 0);
        if (ar == null) return 1;
        if (br == null) return -1;
        if (br !== ar) return br - ar;
        return (b.createdAt || 0) - (a.createdAt || 0);
      });
    } else {
      arr.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    }
    return arr;
  }
  function renderList() {
    const box = $("ncList");
    if (!box) return;
    const arr = visibleList();
    if (!arr.length) {
      box.innerHTML = `<div class="empty"><div class="rad"></div><div><b>Waiting for launches</b><div class="sub">New pump.fun coins appear here the moment PumpPortal reports them.</div></div></div>`;
      return;
    }
    box.innerHTML = arr.map(c => {
      const letter = (c.symbol || c.name || "?").replace(/[^\w]/g, "").slice(0, 2).toUpperCase() || "?";
      const img = safeImg(c.image);
      const av = img
        ? `<div class="av"><img src="${esc(img)}" alt="" onerror="this.remove()"></div>`
        : `<div class="av">${esc(letter)}</div>`;
      const open = state.openMint === c.mint;
      const fomo = "https://fomo.family/tokens/solana/" + encodeURIComponent(c.mint);
      const dex = c.dexUrl || ("https://dexscreener.com/solana/" + encodeURIComponent(c.mint));
      const curve = c.curvePct == null ? "—" : Math.round(c.curvePct) + "%";
      const jarvis = c.jarvis
        ? `<span class="nc-jarvis" title="${esc(c.jarvisNote || c.jarvisVerdict || "Jarvis has checked this coin")}">Jarvis checked${c.confidence != null ? " · " + c.confidence : ""}</span>`
        : "";
      const mayhem = c.mayhem ? `<span class="chip mid">mayhem</span>` : "";
      const detail = open ? `<div class="nc-detail">
        <div class="nc-links">
          <a href="${esc(fomo)}" target="_blank" rel="noopener noreferrer">Open on Fomo ↗</a>
          <a href="${esc(dex)}" target="_blank" rel="noopener noreferrer">Open on DexScreener ↗</a>
        </div>
        <div class="sub mono">${esc(c.mint)}</div>
        <div class="sub">First seen ${esc(awst(c.createdAt))} · source ${esc(c.firstSource || "—")}${c.dex ? " · " + esc(c.dex) : ""}</div>
        ${c.jarvisNote ? `<div class="sub">${esc(c.jarvisNote)}</div>` : ""}
        ${partsHtml("Risk", c.riskParts, c.risk)}
        ${partsHtml("Reward", c.rewardParts, c.reward)}
      </div>` : "";
      return `<div class="nc-row${open ? " open" : ""}" data-mint="${esc(c.mint)}" tabindex="0" role="button">
        ${av}
        <div class="nc-id">
          <b>${esc(c.name || c.symbol || c.mint.slice(0, 6))}</b>
          <span class="mono">${esc(c.symbol || "")}</span>
          <div class="nc-tags">${mayhem}${jarvis}</div>
        </div>
        <div class="nc-m">
          <span class="nc-age mono" data-age="${c.createdAt || ""}">${esc(ageText(c.createdAt))}</span>
          <span class="mono">${esc(kfmt(mcapUsd(c)))}</span>
          <span class="sub">curve ${esc(curve)}</span>
        </div>
        <div class="nc-scores">${pctChip("Risk", c.risk)}${pctChip("Reward", c.reward)}</div>
        ${detail}
      </div>`;
    }).join("");
  }
  function renderMeta() {
    const el = $("ncMeta");
    const pulse = $("ncPulse");
    if (!el) return;
    const n = coins.size;
    const live = state.ws === "live";
    let newest = state.lastEvent;
    coins.forEach(c => { if (c.createdAt && (!newest || c.createdAt > newest)) newest = c.createdAt; });
    const age = newest ? ageText(newest) + " ago" : "no event yet";
    const sol = state.solUsd != null ? " · SOL " + kfmt(state.solUsd) : "";
    el.textContent = (live ? "live · PumpPortal" : state.ws === "reconnect" ? "reconnecting" : "snapshot") +
      " · " + n + " coin" + (n === 1 ? "" : "s") + " · last launch " + age + sol;
    if (pulse) pulse.className = "pulse" + (live ? "" : " idle");
    const liveLab = $("ncLiveLab");
    if (liveLab) {
      liveLab.textContent = live ? "Live" : state.ws === "reconnect" ? "Reconnecting" : "Snapshot";
      liveLab.className = "nc-live" + (live ? "" : " mid");
    }
  }
  function tickAges() {
    document.querySelectorAll("#ncList .nc-age").forEach(el => {
      const ts = Number(el.getAttribute("data-age"));
      if (ts) el.textContent = ageText(ts);
    });
    renderMeta();
  }
  function render() {
    trimMap();
    renderList();
    renderMeta();
  }

  /* ---------- network ---------- */
  async function fetchJson(url, ms) {
    const ctl = ms ? new AbortController() : null;
    const t = ctl ? setTimeout(() => ctl.abort(), ms) : null;
    try {
      const r = await fetch(url, { cache: "no-store", signal: ctl ? ctl.signal : undefined });
      if (!r.ok) return null;
      return await r.json();
    } catch (e) {
      return null;
    } finally {
      if (t) clearTimeout(t);
    }
  }
  async function loadSnapshot() {
    const d = await fetchJson("/data/newcoins.json", 8000) || await fetchJson("data/newcoins.json", 8000);
    if (!d || !Array.isArray(d.tokens)) return;
    d.tokens.forEach(t => {
      if (!t || !t.mint) return;
      const ts = t.received_at ? Date.parse(t.received_at) : Date.now();
      applyCreate(t, "snapshot", Number.isFinite(ts) ? ts : Date.now());
    });
    render();
  }
  async function loadSol() {
    const d = await fetchJson(DEX_SOL, 8000);
    const pairs = Array.isArray(d) ? d : (d && d.pairs) || [];
    let best = 0, px = null;
    pairs.forEach(p => {
      const liq = num(p.liquidity && p.liquidity.usd) || 0;
      const price = num(p.priceUsd);
      if (price && liq >= best) { best = liq; px = price; }
    });
    if (px) {
      state.solUsd = px;
      coins.forEach(rescore);
    }
  }
  async function loadDex() {
    const mints = visibleList().slice(0, 60).map(c => c.mint);
    if (!mints.length) return;
    for (let i = 0; i < mints.length; i += 30) {
      const chunk = mints.slice(i, i + 30);
      const d = await fetchJson(DEX_TOKENS + chunk.join(","), 10000);
      const pairs = Array.isArray(d) ? d : (d && d.pairs) || [];
      pairs.forEach(applyDex);
    }
    state.lastDex = Date.now();
    render();
  }
  async function loadGt() {
    const d = await fetchJson(GT_NEW, 10000);
    if (!d || !Array.isArray(d.data)) return;
    const tokensById = {};
    (d.included || []).forEach(x => {
      if (x && x.type === "token") tokensById[x.id] = x.attributes || {};
    });
    const cutoff = Date.now() - 2 * 3600 * 1000;
    d.data.forEach(p => {
      const created = p.attributes && p.attributes.pool_created_at ? Date.parse(p.attributes.pool_created_at) : 0;
      if (created && created < cutoff) return;
      applyGtPool(p, tokensById);
    });
    render();
  }
  async function loadJarvis() {
    const scan = await fetchJson("/data/latest.json", 8000) || await fetchJson("data/scan.json", 8000);
    const rows = (scan && scan.rows) || [];
    rows.forEach(applyJarvisRow);
    // also anything already in window.__checks from the main dashboard tick
    const pre = window.__checks || {};
    Object.keys(pre).forEach(m => applyChecklist(m, pre[m]));
    const wanted = [...coins.keys()].filter(isMint).slice(0, 60);
    if (wanted.length) {
      const docs = await fetchJson("/api/checklists?mints=" + wanted.join(","), 8000);
      if (docs && typeof docs === "object") {
        Object.keys(docs).forEach(m => applyChecklist(m, docs[m]));
      }
    }
    render();
  }

  function syncTradeSub() {
    if (!ws || ws.readyState !== 1) return;
    const keys = visibleList().slice(0, TRADE_SUB_N).map(c => c.mint);
    const prev = state.tradeKeys;
    const drop = prev.filter(m => keys.indexOf(m) < 0);
    const add = keys.filter(m => prev.indexOf(m) < 0);
    try {
      if (drop.length) ws.send(JSON.stringify({ method: "unsubscribeTokenTrade", keys: drop }));
      if (add.length) ws.send(JSON.stringify({ method: "subscribeTokenTrade", keys: add }));
    } catch (e) {}
    state.tradeKeys = keys;
  }
  function handleWsMsg(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (!msg || typeof msg !== "object") return;
    if (msg.message && !msg.mint) return;
    const tx = msg.txType || "";
    if (tx === "create" || (msg.mint && msg.name && (tx === "" || tx === "create"))) {
      applyCreate(msg, "pumpportal", Date.now());
      state.lastEvent = Date.now();
      syncTradeSub();
      render();
      return;
    }
    if (msg.mint && (tx === "buy" || tx === "sell" || tx === "migration" || msg.marketCapSol != null || msg.vSolInBondingCurve != null)) {
      if (!coins.has(msg.mint)) return;
      applyCreate(msg, "pumpportal", coins.get(msg.mint).createdAt || Date.now());
      if (tx === "buy" || tx === "sell") {
        const c = coins.get(msg.mint);
        if (c) {
          // do not invent 5m counts from a single trade; only refresh curve / mcap
          rescore(c);
        }
      }
      render();
    }
  }
  function connectWs() {
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
    state.ws = "reconnect";
    renderMeta();
    try { ws = new WebSocket(WS_URL); }
    catch (e) { scheduleReconnect(); return; }
    ws.onopen = function () {
      state.ws = "live";
      state.tradeKeys = [];
      try {
        ws.send(JSON.stringify({ method: "subscribeNewToken" }));
        ws.send(JSON.stringify({ method: "subscribeMigration" }));
      } catch (e) {}
      syncTradeSub();
      renderMeta();
    };
    ws.onmessage = function (ev) { handleWsMsg(ev.data); };
    ws.onerror = function () {};
    ws.onclose = function () {
      state.ws = "reconnect";
      renderMeta();
      scheduleReconnect();
    };
  }
  function scheduleReconnect() {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = setTimeout(connectWs, 2000);
  }

  /* ---------- ui events ---------- */
  function onListClick(ev) {
    const row = ev.target.closest(".nc-row");
    if (!row) return;
    if (ev.target.closest("a")) return;
    const mint = row.getAttribute("data-mint");
    state.openMint = (state.openMint === mint) ? null : mint;
    renderList();
  }
  function onListKey(ev) {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    const row = ev.target.closest(".nc-row");
    if (!row) return;
    ev.preventDefault();
    const mint = row.getAttribute("data-mint");
    state.openMint = (state.openMint === mint) ? null : mint;
    renderList();
  }
  function bind() {
    const hide = $("ncHideRisk"), sort = $("ncSortReward"), how = $("ncHowBtn"), pop = $("ncHow");
    const list = $("ncList");
    if (hide) hide.onchange = function () { state.hideHighRisk = hide.checked; render(); };
    if (sort) sort.onchange = function () { state.sortByReward = sort.checked; render(); };
    if (how && pop) {
      how.onclick = function (e) {
        e.stopPropagation();
        const on = pop.hasAttribute("hidden");
        if (on) pop.removeAttribute("hidden"); else pop.setAttribute("hidden", "");
        how.setAttribute("aria-expanded", on ? "true" : "false");
      };
      document.addEventListener("click", function (e) {
        if (pop.hasAttribute("hidden")) return;
        if (e.target.closest("#ncHow, #ncHowBtn")) return;
        pop.setAttribute("hidden", "");
        how.setAttribute("aria-expanded", "false");
      });
    }
    if (list) {
      list.addEventListener("click", onListClick);
      list.addEventListener("keydown", onListKey);
    }
    const chip = $("newCoinsChip");
    if (chip) chip.onclick = function () {
      document.body.dataset.tab = "new";
      document.querySelectorAll("#tabs button").forEach(x => x.classList.toggle("on", x.dataset.t === "new"));
      const card = $("newCoinsCard");
      if (card) card.scrollIntoView({ behavior: "smooth", block: "start" });
    };
  }

  async function start() {
    if (!$("newCoinsCard")) return;
    bind();
    render();
    await loadSnapshot();
    await loadSol();
    connectWs();
    loadGt();
    loadDex();
    loadJarvis();
    setInterval(loadSol, 60000);
    setInterval(loadDex, DEX_POLL_MS);
    setInterval(loadGt, GT_POLL_MS);
    setInterval(loadJarvis, JARVIS_POLL_MS);
    setInterval(function () {
      // snapshot is a fallback when the socket is down (local is fresh; Pages lags ~60s)
      if (state.ws !== "live") loadSnapshot();
    }, SNAP_POLL_MS);
    ageTimer = setInterval(tickAges, 1000);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
