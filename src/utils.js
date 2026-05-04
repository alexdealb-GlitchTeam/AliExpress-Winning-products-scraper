/**
 * utils.js — Helper functions for AliExpress scraper
 */

/**
 * Parses order count from strings like "1.2k+ sold", "500+ sold", "10000 sold"
 */
export function parseOrderCount(str) {
  if (!str) return 0;
  const clean = str.toLowerCase().replace(/[^0-9.k+]/g, '');
  if (clean.includes('k')) {
    return Math.round(parseFloat(clean) * 1000);
  }
  return parseInt(clean) || 0;
}

/**
 * Parses price string "€ 12,99" or "12.99" → float
 */
export function parsePrice(str) {
  if (!str) return null;
  const match = str.replace(',', '.').match(/[\d.]+/);
  return match ? parseFloat(match[0]) : null;
}

/**
 * Builds an AliExpress search URL with sort + country params
 */
export function buildSearchUrl({ query, page = 1, sortBy = 'LAST_SEVEN_DAYS_VOLUME', country = 'FR', currency = 'EUR' }) {
  const params = new URLSearchParams({
    SearchText: query,
    sortType: sortBy,
    page,
    shipCountry: country.toLowerCase(),
    currency,
    origin: 'y',
    isrefine: 'y',
  });
  return `https://www.aliexpress.com/wholesale?${params.toString()}`;
}

/**
 * Builds a category listing URL with page + sort
 */
export function buildCategoryUrl({ baseUrl, page = 1, sortBy = 'LAST_SEVEN_DAYS_VOLUME', country = 'FR', currency = 'EUR' }) {
  const url = new URL(baseUrl);
  url.searchParams.set('SortType', sortBy);
  url.searchParams.set('page', page);
  url.searchParams.set('shipCountry', country.toLowerCase());
  url.searchParams.set('currency', currency);
  return url.toString();
}

/**
 * Extract product ID from AliExpress product URL
 */
export function extractProductId(url) {
  const match = url.match(/\/item\/(\d+)\.html/);
  return match ? match[1] : null;
}

/**
 * Parse global JS data from AliExpress page
 * Covers multiple AliExpress versions (classic, SPA 2024/2025/2026)
 * 
 * FIX: window.PAGE_VARIABLES was broken (markdown link artifact)
 * FIX: Added new 2026 data paths used by AliExpress
 */
export async function extractPageGlobalData(page) {
  return page.evaluate(() => {
    // ── Try known global variables ────────────────────────────────────────────
    const candidates = [
      window.__GLOBAL_DATA__,
      window.runParams,
      window._dida_config_,
      window.PAGE_VARIABLES,        // FIX: was broken as markdown link
      window.__pageData__,
      window._init_data_,
      window.detailData,            // NEW: AliExpress 2025/2026 detail pages
      window.__ali_data__,          // NEW: seen in some AliExpress regions
    ];

    for (const c of candidates) {
      if (c && typeof c === 'object' && Object.keys(c).length > 0) return c;
    }

    // ── Fallback: parse from inline <script> tags ─────────────────────────────
    const scripts = Array.from(document.querySelectorAll('script:not([src])'));

    const patterns = [
      // Classic
      /window\.__GLOBAL_DATA__\s*=\s*(\{[\s\S]+?\});\s*(?:window|var|let|const|$)/,
      /window\.runParams\s*=\s*(\{[\s\S]+?\});\s*(?:var|window|let|const|$)/,
      // 2024+ SPA
      /window\._dida_config_\s*=\s*(\{[\s\S]+?\});\s*(?:window|var|$)/,
      /window\.PAGE_VARIABLES\s*=\s*(\{[\s\S]+?\});\s*(?:window|var|$)/,
      // 2025/2026
      /window\.detailData\s*=\s*(\{[\s\S]+?\});\s*(?:window|var|$)/,
      /"data"\s*:\s*(\{[\s\S]{100,}\})\s*,\s*"header"/,  // embedded JSON
    ];

    for (const script of scripts) {
      const text = script.textContent || '';
      if (text.length < 50) continue;

      for (const pattern of patterns) {
        const m = text.match(pattern);
        if (m) {
          try {
            const parsed = JSON.parse(m[1]);
            if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 2) {
              return parsed;
            }
          } catch { /* continue */ }
        }
      }
    }

    // ── Last resort: look for any large JSON object with product-like keys ────
    for (const script of scripts) {
      const text = script.textContent || '';
      if (text.length < 500) continue;

      const m = text.match(/(\{[^{}]*"priceModule"[^{}]*\{[\s\S]+?\})/);
      if (m) {
        try { return JSON.parse(m[1]); } catch { /* continue */ }
      }
    }

    return null;
  });
}

/**
 * Random sleep to mimic human browsing
 */
export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Cleans up a title string
 */
export function cleanTitle(str) {
  if (!str) return '';
  return str.replace(/\s+/g, ' ').trim();
}

/**
 * Extracts numeric rating from strings like "4.8 out of 5" or "4.8"
 */
export function parseRating(str) {
  if (!str && typeof str !== 'number') return null;
  if (typeof str === 'number') return str;
  const match = String(str).match(/[\d.]+/);
  return match ? parseFloat(match[0]) : null;
}

/**
 * Builds product URL from productId
 */
export function buildProductUrl(productId) {
  return `https://www.aliexpress.com/item/${productId}.html`;
}

/**
 * Deep-gets a nested value from an object using a dot-path string
 * e.g. deepGet(obj, 'data.product.price.minPrice')
 */
export function deepGet(obj, path) {
  return path.split('.').reduce((acc, key) => (acc && acc[key] !== undefined ? acc[key] : null), obj);
}