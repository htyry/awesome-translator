// Free translation using Google Translate non-API endpoint (no key required)

const LANG_MAP = {
  zh: 'zh-CN', 'zh-CN': 'zh-CN', 'zh-TW': 'zh-TW',
  en: 'en', ja: 'ja', ko: 'ko',
  fr: 'fr', de: 'de', es: 'es',
  pt: 'pt', it: 'it', ru: 'ru',
  ar: 'ar', hi: 'hi',
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export async function freeTranslate(text, targetLang = 'zh') {
  const tl = LANG_MAP[targetLang] || targetLang;
  const url =
    `https://translate.googleapis.com/translate_a/single` +
    `?client=gtx&sl=auto&tl=${encodeURIComponent(tl)}&dt=t&q=${encodeURIComponent(text)}`;

  const maxRetries = 2;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        if ((response.status === 429 || (response.status >= 500 && response.status < 600)) && attempt < maxRetries) {
          await sleep(500 * (attempt + 1));
          continue;
        }
        throw new Error(`Free translation error: ${response.status}`);
      }

      const data = await response.json();

      if (data && Array.isArray(data[0])) {
        return data[0].map(item => item?.[0] || '').join('');
      }

      throw new Error('Free translation failed: unexpected response');
    } catch (e) {
      if (attempt < maxRetries && e.name !== 'Error') {
        await sleep(500 * (attempt + 1));
        continue;
      }
      throw e;
    }
  }
}
