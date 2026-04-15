// Free translation using Google Translate non-API endpoint (no key required)

const LANG_MAP = {
  zh: 'zh-CN', 'zh-CN': 'zh-CN', 'zh-TW': 'zh-TW',
  en: 'en', ja: 'ja', ko: 'ko',
  fr: 'fr', de: 'de', es: 'es',
  pt: 'pt', it: 'it', ru: 'ru',
  ar: 'ar', hi: 'hi',
};

export async function freeTranslate(text, targetLang = 'zh') {
  const tl = LANG_MAP[targetLang] || targetLang;
  const url =
    `https://translate.googleapis.com/translate_a/single` +
    `?client=gtx&sl=auto&tl=${encodeURIComponent(tl)}&dt=t&q=${encodeURIComponent(text)}`;

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Free translation error: ${response.status}`);

  const data = await response.json();

  if (data && Array.isArray(data[0])) {
    return data[0].map(item => item?.[0] || '').join('');
  }

  throw new Error('Free translation failed: unexpected response');
}
