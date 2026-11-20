/* Static-site shim for GitHub Pages.
   On localhost this file is a no-op (fetch is unchanged).
   Elsewhere, if /data/* and /api/* are unavailable, it serves data/*.json
   snapshots and live DexScreener prices. Pins are read-only on the static site.
*/
(function () {
  const isLocal = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  const origFetch = window.fetch.bind(window);
  const ROOT = new URL("./", document.currentScript.src);
  const READONLY_MSG = "Pins are read-only on the public dashboard. Ask Jarvis in chat to pin a coin.";
  let mode = isLocal ? "api" : "unknown"; // "api" | "static"

  function jsonResp(obj, code) {
    return new Response(JSON.stringify(obj), {
      status: code || 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
    });
  }
  function textResp(text, type) {
    return new Response(text, {
      status: 200,
      headers: { "Content-Type": type || "application/json", "Cache-Control": "no-store" }
    });
  }
  function asJsonl(arr) {
    const lines = (Array.isArray(arr) ? arr : []).map((x) => JSON.stringify(x)).join("\n");
    return textResp(lines ? lines + "\n" : "", "application/json");
  }
  async function snap(name) {
    const r = await origFetch(new URL("data/" + name, ROOT), { cache: "no-store" });
    if (!r.ok) return null;
    return r.json();
  }

  function markReadOnly() {
    document.documentElement.dataset.static = "1";
    const style = document.createElement("style");
    style.textContent = [
      'html[data-static] #pinIn,html[data-static] #pinGo,html[data-static] .pinbtn,html[data-static] button.x{display:none!important}',
      'html[data-static] #cands{display:none}',
      '#jarvis-static-note{margin:0 0 12px;padding:8px 12px;border-radius:10px;border:1px solid rgba(140,170,255,.18);background:rgba(18,24,38,.55);color:#7c8aa3;font:600 11px/1.4 ui-monospace,monospace}'
    ].join("");
    document.head.appendChild(style);
    function banner(info) {
      if (document.getElementById("jarvis-static-note")) return;
      const n = document.createElement("div");
      n.id = "jarvis-static-note";
      n.textContent = "Public snapshot" + (info ? " · updated " + info : "") + " · refreshes about every 60s · pins are read-only (ask Jarvis in chat)";
      const wrap = document.querySelector(".wrap");
      if (wrap) wrap.insertBefore(n, wrap.firstChild);
    }
    const go = () => {
      banner("");
      snap("state.json").then((s) => {
        if (s && s.published_at) {
          const el = document.getElementById("jarvis-static-note");
          if (el) el.textContent = "Public snapshot · updated " + s.published_at + " · refreshes about every 60s · pins are read-only (ask Jarvis in chat)";
        }
      });
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", go);
    else go();
  }

  const ready = (async () => {
    if (isLocal) return;
    try {
      const r = await origFetch("/data/live/status.json", { cache: "no-store" });
      mode = r.ok ? "api" : "static";
    } catch (e) {
      mode = "static";
    }
    if (mode === "static") markReadOnly();
  })();

  async function dexPrices(mints) {
    const out = {};
    const list = (mints || "").split(",").map((m) => m.trim()).filter(Boolean).slice(0, 60);
    for (let i = 0; i < list.length; i += 30) {
      const chunk = list.slice(i, i + 30);
      const url = "https://api.dexscreener.com/tokens/v1/solana/" + chunk.join(",");
      const r = await origFetch(url, { cache: "no-store" });
      const pairs = r.ok ? await r.json() : [];
      for (const p of Array.isArray(pairs) ? pairs : []) {
        const m = p && p.baseToken && p.baseToken.address;
        if (!m) continue;
        const liq = (p.liquidity && p.liquidity.usd) || 0;
        if (!out[m] || liq > out[m].liq_usd) {
          const ch = p.priceChange || {};
          const vol = p.volume || {};
          const tx = (p.txns && p.txns.m5) || {};
          out[m] = {
            price_usd: parseFloat(p.priceUsd || 0),
            liq_usd: liq,
            chg5m: ch.m5,
            symbol: p.baseToken.symbol,
            url: p.url,
            image: (p.info && p.info.imageUrl) || null,
            mc_usd: p.marketCap || p.fdv,
            vol5m: vol.m5,
            buys5m: tx.buys,
            sells5m: tx.sells,
            pair: p.pairAddress,
            dex: p.dexId,
            chg1h: ch.h1
          };
        }
      }
    }
    return { t: Date.now() / 1000, source: "api.dexscreener.com", prices: out };
  }

  async function staticHandle(url, method) {
    const path = url.pathname;
    const q = url.searchParams;

    if (method !== "GET") {
      if (path === "/api/pin" || path === "/api/unpin") return jsonResp({ ok: false, error: READONLY_MSG }, 405);
      return null;
    }
    if (path === "/api/resolve") return jsonResp({ candidates: [], error: READONLY_MSG });
    if (path === "/api/prices") {
      try { return jsonResp(await dexPrices(q.get("mints") || "")); }
      catch (e) {
        const p = await snap("prices.json");
        return p ? jsonResp(p) : jsonResp({ t: Date.now() / 1000, source: "snapshot", prices: {} });
      }
    }
    if (path === "/api/tax.csv") {
      const r = await origFetch(new URL("data/tax_log.csv", ROOT), { cache: "no-store" });
      if (!r.ok) return new Response("# Record-keeping only, not tax advice.\ndate_time_ET,type,coin_symbol,mint,quantity,usd_amount,fee_usd,cost_basis_usd,proceeds_usd,gain_loss_usd,holding_period,tx_ref,reason\n", { status: 200, headers: { "Content-Type": "text/csv; charset=utf-8", "Cache-Control": "no-store" } });
      return r;
    }
    if (path === "/api/stats") {
      const s = await snap("stats.json");
      return jsonResp(s || { empty: true });
    }
    if (path === "/api/health") {
      const h = await snap("health.json");
      return jsonResp(h || { ok: false, empty: true });
    }
    if (path === "/api/checklist") {
      const mint = q.get("mint") || "";
      const all = (await snap("checklists.json")) || {};
      const doc = all[mint];
      if (!doc) return jsonResp({ error: "no checklist for this mint" }, 404);
      return jsonResp(doc);
    }
    if (path === "/api/checklists") {
      const all = (await snap("checklists.json")) || {};
      const want = (q.get("mints") || "").split(",").map((m) => m.trim()).filter(Boolean);
      if (!want.length) return jsonResp(all);
      const out = {};
      want.forEach((m) => { if (all[m]) out[m] = all[m]; });
      return jsonResp(out);
    }
    if (path === "/api/ohlcv") {
      const pool = q.get("pool") || "";
      const d = (await snap("ohlcv.json")) || {};
      const rec = (d.pools && d.pools[pool]) || d[pool] || { candles: [], pool, source: "snapshot" };
      return jsonResp(rec);
    }

    const state = (await snap("state.json")) || {};
    const live = state.live || {};
    const paper = state.paper || {};

    const map = {
      "/data/latest.json": async () => jsonResp((await snap("scan.json")) || {}),
      "/data/watchlist.json": async () => jsonResp((await snap("watchlist.json")) || {}),
      "/data/strategies.json": async () => jsonResp((await snap("strategies.json")) || {}),
      "/data/live/balance.json": async () => jsonResp(live.balance || null),
      "/data/live/positions.json": async () => jsonResp(live.positions || []),
      "/data/live/status.json": async () => jsonResp(live.status || {}),
      "/data/live/health.json": async () => jsonResp((await snap("health.json")) || { ok: false, empty: true }),
      "/data/live/stats.json": async () => jsonResp((await snap("stats.json")) || { empty: true }),
      "/data/live/trading_paused.json": async () => jsonResp((await snap("trading_paused.json")) || {}),
      "/data/live/limits.json": async () => jsonResp(live.limits || {}),
      "/data/live/pinned.json": async () => jsonResp((await snap("pinned.json")) || { pins: [] }),
      "/data/live/trades.jsonl": async () => asJsonl(((await snap("trades.json")) || {}).live || []),
      "/data/live/equity.jsonl": async () => asJsonl(live.equity || []),
      "/data/live/log.jsonl": async () => asJsonl((await snap("log.json")) || []),
      "/data/live/alerts.jsonl": async () => asJsonl((await snap("alerts.json")) || []),
      "/data/paper/balance.json": async () => jsonResp(paper.balance || null),
      "/data/paper/positions.json": async () => jsonResp(paper.positions || []),
      "/data/paper/trades.jsonl": async () => asJsonl(((await snap("trades.json")) || {}).paper || []),
      "/data/paper/equity.jsonl": async () => asJsonl(paper.equity || []),
      "/data/paper/status.json": async () => jsonResp(paper.status || live.status || {}),
      "/data/paper/limits.json": async () => jsonResp(paper.limits || live.limits || {}),
      "/data/paper/pinned.json": async () => jsonResp((await snap("pinned.json")) || { pins: [] }),
      "/data/paper/alerts.jsonl": async () => asJsonl((await snap("alerts.json")) || []),
      "/data/paper/log.jsonl": async () => asJsonl((await snap("log.json")) || []),
      "/data/push_public.json": async () => jsonResp((await snap("push_public.json")) || {}),
      "/data/digest_latest.json": async () => jsonResp((await snap("digest_latest.json")) || null),
      "/data/digests.json": async () => jsonResp((await snap("digests.json")) || { days: [] })
    };
    if (map[path]) return map[path]();
    const digestDay = path.match(/^\/data\/digests\/(\d{4}-\d{2}-\d{2})\.json$/);
    if (digestDay) return jsonResp((await snap("digests/" + digestDay[1] + ".json")) || null);
    return null;
  }

  window.fetch = async function (input, init) {
    if (isLocal || mode === "api") return origFetch(input, init);
    await ready;
    if (mode === "api") return origFetch(input, init);
    try {
      const url = new URL(typeof input === "string" ? input : input.url, location.href);
      const method = ((init && init.method) || (typeof input !== "string" && input.method) || "GET").toUpperCase();
      if (url.origin === location.origin) {
        const hit = await staticHandle(url, method);
        if (hit) return hit;
      }
    } catch (e) { /* fall through to network */ }
    return origFetch(input, init);
  };

  if (!isLocal) ready.catch(() => {});
})();
