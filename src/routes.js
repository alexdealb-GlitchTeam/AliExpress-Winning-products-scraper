import { sleep } from './utils.js';

/**
 * handleSearchPage - EXTRACTION RAPIDE (Fast Mode)
 * Récupère les données directement depuis la liste sans ouvrir les pages produits.
 */
export async function handleSearchPage({ page, request, log, pushData }) {
  const { query, maxProducts, country, currency, requestDelay } = request.userData;

  log.info(`🚀 [FAST-MODE] Démarrage pour : "${query}"`);

  // Attendre que la page soit bien chargée
  await page.waitForLoadState('networkidle');
  await sleep(requestDelay || 1000);

  // Extraction des données directement dans la page de recherche
  const products = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('[class*="product-card"], [class*="item-card"], a[href*="/item/"]'));
    
    return cards.map((el) => {
      const link = el.querySelector('a[href*="/item/"]') || (el.tagName === 'A' ? el : null);
      const titleEl = el.querySelector('[class*="title"], h3');
      const priceEl = el.querySelector('[class*="price--current"]');
      const imgEl = el.querySelector('img');

      if (!link || !titleEl) return null;

      return {
        title: titleEl.textContent?.trim(),
        url: link.href,
        price: priceEl?.textContent?.trim(),
        aliexpress_image: imgEl?.src || imgEl?.getAttribute('lazy-src'),
      };
    }).filter(p => p !== null);
  });

  // On limite au nombre demandé (maxProductsPerQuery)
  const selection = products.slice(0, maxProducts);
  
  for (const item of selection) {
    // Nettoyage de l'image pour n8n (HD + HTTPS)
    if (item.aliexpress_image) {
       item.aliexpress_image = item.aliexpress_image.split('_.webp')[0].split('.jpg_')[0];
       if (item.aliexpress_image.startsWith('//')) {
         item.aliexpress_image = 'https:' + item.aliexpress_image;
       }
    }
    
    // Envoi direct des données à n8n sans passer par l'étape PRODUCT_PAGE
    await pushData({
      ...item,
      searchQuery: query,
      scrapedAt: new Date().toISOString(),
      fastMode: true
    });
  }

  log.info(`✅ Succès : ${selection.length} produits extraits en quelques secondes.`);
}

/**
 * On garde handleProductPage vide ou minimaliste pour éviter les erreurs d'import
 * mais elle ne sera plus appelée dans ce mode.
 */
export async function handleProductPage() {
    // Non utilisée en mode rapide
}

export async function handleReviewsApi() {
    // Non utilisée en mode rapide
}