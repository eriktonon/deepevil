'use strict';

const { request } = require('undici');
const { createSafeHttpDispatcher } = require('../security');
const { SEARCH_LANGUAGES, normalizeSearchLang } = require('./planner');

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos
const DEFAULT_HEADLINE_DEADLINE_MS = 2200;

/**
 * Cache em memória com TTL configurável (padrão 5 minutos) e evicção LRU gradual
 * (sem `.clear()` brusco).
 */
class TtlCache {
  constructor({ ttlMs = DEFAULT_CACHE_TTL_MS, maxEntries = 400 } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.store = new Map();
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    // Refresh LRU order
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  has(key) {
    return this.get(key) !== undefined;
  }

  set(key, value) {
    const now = Date.now();
    if (this.store.has(key)) {
      this.store.delete(key);
    }
    if (this.store.size >= this.maxEntries) {
      // Remove primeiro entradas expiradas, depois o item mais antigo (LRU)
      for (const [k, v] of this.store.entries()) {
        if (now > v.expiresAt) {
          this.store.delete(k);
        }
        if (this.store.size < this.maxEntries) break;
      }
      while (this.store.size >= this.maxEntries) {
        const oldestKey = this.store.keys().next().value;
        if (oldestKey === undefined) break;
        this.store.delete(oldestKey);
      }
    }
    this.store.set(key, { value, expiresAt: now + this.ttlMs });
  }

  get size() {
    return this.store.size;
  }
}

const safeTranslatorDispatcher = createSafeHttpDispatcher({
  timeout: 3000,
  headersTimeout: 2500,
  bodyTimeout: 2500
});

const headlineTranslationCache = new TtlCache({ ttlMs: DEFAULT_CACHE_TTL_MS, maxEntries: 500 });
const queryPoleTranslationCache = new TtlCache({ ttlMs: DEFAULT_CACHE_TTL_MS, maxEntries: 350 });
let gtxRateLimitedUntil = 0;

/**
 * Marcas técnicas, produtos, projetos e siglas protegidas contra tradução literal
 * (impede "Abraçando o rosto", "escopo do modelo", "Caixa traseira", "Fundição Palantir").
 */
const PROTECTED_TECH_BRANDS = [
  'Hugging Face',
  'HuggingFace',
  'ModelScope',
  'OpenCSG',
  'WiseModel',
  'Gitee AI',
  'BackBox Linux',
  'BackBox',
  'Kali Linux',
  'Arch Linux',
  'Linux',
  'GitHub',
  'GitLab',
  'OpenAI',
  'DeepSeek',
  'Qwen',
  'Anthropic',
  'Claude',
  'Google',
  'Gemini',
  'Windows',
  'Docker',
  'Kubernetes',
  'Rust',
  'Python',
  'Node.js',
  'TypeScript',
  'JavaScript',
  'PostgreSQL',
  'SQLite',
  'Qdrant',
  'Ollama',
  'Palantir Foundry',
  'Palantir AIP',
  'Palantir',
  'Foundry',
  'ArXiv',
  'OpenAlex',
  'Habr',
  'Yandex',
  'CyberLeninka',
  'SearXNG',
  'Readability',
  'Granite',
  'OpenCompass',
  'LiveBench',
  'SWE-bench',
  'Cloudflare',
  'OPNsense',
  'pfSense',
  'Proxmox',
  'Fastify',
  'TestDisk',
  'PhotoRec',
  'Autopsy',
  'Foremost',
  'Scalpel',
  'Wireshark',
  'Metasploit',
  'Nmap',
  'Liveuamap',
  'ACLED',
  'eBPF',
  'XDP',
  'DPDK',
  'Ftrace',
  'QUIC',
  'Kademlia',
  'Iroh',
  'ITER',
  'Tokamak',
  'Blender',
  'FreeCAD',
  'OpenSCAD',
  'SciELO'
];

const PROTECTED_BRAND_REGEX = new RegExp(
  `\\b(${PROTECTED_TECH_BRANDS.map((b) => b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`,
  'gi'
);

/**
 * Substitui entidades protegidas (`owner/repo`, códigos/callsigns `UVB-76`, `CVE-...`, `RFC-...`,
 * `HFGCS` e marcas tech) por tokens alfanuméricos opacos antes da tradução.
 */
function protectEntities(text) {
  const placeholders = [];
  let masked = String(text || '');

  const maskMatch = (match) => {
    const idx = placeholders.length;
    placeholders.push(match);
    return `ZXQ${idx}ZXQ`;
  };

  // 1. Repositórios GitHub/GitLab owner/repo
  masked = masked.replace(/\b[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\b/g, maskMatch);

  // 2. Códigos técnicos / Callsigns / CVEs / RFCs (ex.: CVE-2025-12345, UVB-76, RFC-9110, T-15MD, SHA-256)
  masked = masked.replace(/\b(?:CVE-\d{4}-\d{4,7}|RFC[-\s]?\d{3,5}|[A-Z]{2,6}-\d{1,5}[A-Z0-9]*|HFGCS|OSDK|MERA|SMR)\b/g, maskMatch);

  // 3. Marcas de tecnologia conhecidas
  masked = masked.replace(PROTECTED_BRAND_REGEX, maskMatch);

  return { masked, placeholders };
}

/**
 * Restaura os placeholders protegidos preservando a grafia original e limpa vazamentos residuais.
 */
function restoreEntities(translatedText, placeholders = [], targetTl = 'pt') {
  let restored = String(translatedText || '');
  for (let i = 0; i < placeholders.length; i++) {
    const tokenRe = new RegExp(`ZXQ\\s*${i}\\s*ZXQ`, 'gi');
    restored = restored.replace(tokenRe, placeholders[i]);
  }

  // Correções defensivas contra traduções literais caso o motor externo quebre algum termo
  restored = restored
    .replace(/\bAbra[çc]ando\s+o\s+rosto\b/gi, 'Hugging Face')
    .replace(/\bRosto\s+abra[çc]ado\b/gi, 'Hugging Face')
    .replace(/\bEscopo\s+do\s+modelo\b/gi, 'ModelScope')
    .replace(/\bFundi[çc][ãa]o\s+Palantir\b/gi, 'Palantir Foundry')
    .replace(/\bCaixa\s+traseira\b/gi, 'BackBox')
    .replace(/\s+/g, ' ')
    .trim();

  if (targetTl === 'pt') {
    restored = restored
      .replace(/\bKnowledge\s+Graphs\b/gi, 'Grafos de Conhecimento')
      .replace(/\bKnowledge\s+Graph\b/gi, 'Grafo de Conhecimento')
      .replace(/\bLarge\s+Language\s+Models\b/gi, 'Grandes Modelos de Linguagem (LLMs)');
  }

  return restored;
}

function createDeadlineController(timeoutMs, externalSignal = null) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }
  const cleanup = () => {
    clearTimeout(timer);
    if (externalSignal) {
      externalSignal.removeEventListener('abort', onExternalAbort);
    }
  };
  return { signal: controller.signal, cleanup };
}

function detectSourceLangHint(text, badgeStr = '') {
  if (/[\uac00-\ud7af]/.test(text)) return 'ko';
  if (/[\u3040-\u30ff]/.test(text)) return 'ja';
  if (/[\u4e00-\u9fff]/.test(text)) return badgeStr.includes('JP') ? 'ja' : 'zh-CN';
  if (/[\u0400-\u04ff]/.test(text)) return 'ru';
  if (/\b(the|and|for|with|using|into|from|towards|survey|benchmarking|unpacking|bridging|decision-making|knowledge|language|models|engineering|recovery|conflict|live)\b/i.test(text)) {
    return 'en';
  }
  return 'auto';
}

/**
 * Localiza headlines (`title`) das fontes extraídas para o idioma selecionado (`searchLang`),
 * protegendo NER/marcas/códigos, preservando bandeira de polo + sufixo da fonte,
 * com TTL cache de 5 min, `AbortSignal` e deadline curto (<= 2200ms).
 */
async function localizeSourceHeadlines(sources = [], targetLang = 'pt-BR', {
  httpRequest = request,
  timeoutMs = DEFAULT_HEADLINE_DEADLINE_MS,
  signal = null
} = {}) {
  if (!Array.isArray(sources) || sources.length === 0) return [];
  if (httpRequest !== request) return sources;
  if (signal?.aborted) return sources;

  const totalDeadlineMs = Math.min(Math.max(400, Number(timeoutMs) || DEFAULT_HEADLINE_DEADLINE_MS), DEFAULT_HEADLINE_DEADLINE_MS);
  const { signal: deadlineSignal, cleanup } = createDeadlineController(totalDeadlineMs, signal);

  const langKey = normalizeSearchLang(targetLang);
  const langSpec = SEARCH_LANGUAGES[langKey] || SEARCH_LANGUAGES['pt-BR'];
  const tl = langSpec.tl || 'pt';
  const perReqTimeout = Math.min(1600, totalDeadlineMs);

  const translateSingleSource = async (src) => {
    if (deadlineSignal.aborted || !src || typeof src.title !== 'string') return src;
    const rawTitle = src.title.trim();
    if (!rawTitle) return src;

    const badgeMatch = rawTitle.match(/^(\[(?:🇺🇸|🇨🇳|🇩🇪|🇯🇵|🇰🇷|🇷🇺|🇧🇷|🌍)[^\]]+\])\s*/);
    const badge = badgeMatch ? `${badgeMatch[1]} ` : '';
    const withoutBadge = badgeMatch ? rawTitle.slice(badgeMatch[0].length).trim() : rawTitle;

    // Se já estiver no idioma alvo (ex.: polo BR com alvo PT), pula chamada desnecessária
    if (tl === 'pt' && badge.includes('🇧🇷')) {
      return src;
    }

    // Protege identificadores de repositório GitHub no início
    const repoMatch = withoutBadge.match(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\s+[—-]\s+(.+)$/);
    const repoPrefix = repoMatch ? `${repoMatch[1]} — ` : '';
    const textAfterRepo = repoMatch ? repoMatch[2].trim() : withoutBadge;

    // Separa sufixo de atribuição (ex.: " — Wikipedia (ZH)", " — Habr Engineering", " — Yandex Search")
    const suffixMatch = !repoMatch
      ? textAfterRepo.match(/(\s+—\s+(?:Wikipedia\s*\([A-Z]{2}\)|Habr(?:\s+Engineering)?|Yandex(?:\s+Search|\s*\/\/\s*CyberLeninka)?|ArXiv\s+Global\s+Preprint|GitHub\s+Repository))$/)
      : null;
    const suffix = suffixMatch ? suffixMatch[1] : '';
    const coreSubject = suffixMatch
      ? textAfterRepo.slice(0, textAfterRepo.length - suffix.length).trim()
      : textAfterRepo;

    if (!coreSubject || coreSubject.length < 3 || /^https?:\/\//i.test(coreSubject)) {
      return src;
    }

    const sl = detectSourceLangHint(coreSubject, badge);
    if (sl === tl || (sl === 'en' && tl === 'en')) {
      return src;
    }

    const cacheKey = `${sl}->${tl}::${coreSubject}`;
    let translatedCore = headlineTranslationCache.get(cacheKey);

    if (!translatedCore && Date.now() >= gtxRateLimitedUntil && !deadlineSignal.aborted) {
      const { masked, placeholders } = protectEntities(coreSubject);
      // Se o título inteiro consistir apenas de entidades protegidas, não há o que traduzir
      if (!masked.replace(/ZXQ\d+ZXQ/g, '').replace(/[\s\-—–:|/(),.]+/g, '').trim()) {
        return src;
      }

      try {
        const gtxUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(tl)}&dt=t&q=${encodeURIComponent(masked)}`;
        const res = await httpRequest(gtxUrl, {
          method: 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36',
            'Accept': 'application/json'
          },
          dispatcher: safeTranslatorDispatcher,
          headersTimeout: perReqTimeout,
          bodyTimeout: perReqTimeout,
          signal: deadlineSignal
        });

        if (res.statusCode === 200) {
          const payload = await res.body.json();
          if (Array.isArray(payload?.[0])) {
            const rawJoined = payload[0]
              .map((seg) => (Array.isArray(seg) && typeof seg[0] === 'string' ? seg[0] : ''))
              .join('');
            const restored = restoreEntities(rawJoined, placeholders, tl);
            if (restored.length >= 2) {
              translatedCore = restored;
              headlineTranslationCache.set(cacheKey, translatedCore);
            }
          }
        } else {
          if (res.statusCode === 429 || res.statusCode === 403) {
            gtxRateLimitedUntil = Date.now() + 180_000;
          }
          if (res.body && typeof res.body.dump === 'function') {
            await res.body.dump().catch(() => {});
          }
        }
      } catch (_) {
        // Timeout/Abort -> retorna original sem atrasar TTFT
      }
    }

    if (!translatedCore) {
      return src;
    }

    const newTitle = `${badge}${repoPrefix}${translatedCore}${suffix}`.replace(/\s+/g, ' ').trim();
    return {
      ...src,
      originalTitle: rawTitle,
      title: newTitle
    };
  };

  try {
    const results = new Array(sources.length);
    const concurrency = Math.min(4, sources.length);
    let nextIdx = 0;

    const worker = async () => {
      while (nextIdx < sources.length) {
        const idx = nextIdx++;
        if (deadlineSignal.aborted) {
          results[idx] = sources[idx];
          continue;
        }
        results[idx] = await translateSingleSource(sources[idx]);
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    return results.map((r, idx) => r || sources[idx]);
  } finally {
    cleanup();
  }
}

/**
 * Traduz dinamicamente uma consulta para os idiomas dos polos (`en`, `zh-CN`, `de`, `ja`, `ko`, `ru`)
 * quando ela não bateu em um dicionário de domínio pré-mapeado, respeitando `AbortSignal`,
 * proteção de entidades/marcas e TTL cache de 5 minutos.
 */
async function enrichMultiPolarQueriesWithTranslation(poles, rawQuery, {
  httpRequest = request,
  timeoutMs = 1800,
  signal = null
} = {}) {
  if (httpRequest !== request) return poles;
  if (signal?.aborted) return poles;

  const needsLiveTranslation = poles.cn === poles.enCore && !/[\u4e00-\u9fff]/.test(poles.cn);
  if (!needsLiveTranslation) return poles;

  const baseText = String(poles.br || rawQuery || poles.enCore || '').trim();
  if (!baseText || baseText.length < 3) return poles;

  const { signal: deadlineSignal, cleanup } = createDeadlineController(
    Math.min(Math.max(500, Number(timeoutMs) || 1800), 2200),
    signal
  );

  const { masked, placeholders } = protectEntities(baseText);

  const translateQuick = async (tl) => {
    if (deadlineSignal.aborted) return '';
    const cacheKey = `${tl}::${baseText}`;
    const cached = queryPoleTranslationCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    if (Date.now() >= gtxRateLimitedUntil) {
      try {
        const gtxUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(tl)}&dt=t&q=${encodeURIComponent(masked)}`;
        const res = await httpRequest(gtxUrl, {
          method: 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36',
            'Accept': 'application/json'
          },
          dispatcher: safeTranslatorDispatcher,
          headersTimeout: timeoutMs,
          bodyTimeout: timeoutMs,
          signal: deadlineSignal
        });
        if (res.statusCode === 200) {
          const payload = await res.body.json();
          if (Array.isArray(payload?.[0])) {
            const rawJoined = payload[0]
              .map((seg) => (Array.isArray(seg) && typeof seg[0] === 'string' ? seg[0] : ''))
              .join('')
              .replace(/[?!.]+$/g, '');
            const joined = restoreEntities(rawJoined, placeholders, tl);
            if (joined) {
              queryPoleTranslationCache.set(cacheKey, joined);
              return joined;
            }
          }
        } else {
          if (res.statusCode === 429 || res.statusCode === 403) {
            gtxRateLimitedUntil = Date.now() + 180_000;
          }
          if (res.body && typeof res.body.dump === 'function') {
            await res.body.dump().catch(() => {});
          }
        }
      } catch (_) {}
    }

    if (deadlineSignal.aborted) return '';

    // Fallback sem CAPTCHA via MyMemory
    try {
      const mmUrl = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(masked)}&langpair=${encodeURIComponent(`pt|${tl}`)}`;
      const mmRes = await httpRequest(mmUrl, {
        method: 'GET',
        headers: {
          'User-Agent': 'DeepEvil/1.0 (Global Research Engine)',
          'Accept': 'application/json'
        },
        dispatcher: safeTranslatorDispatcher,
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
        signal: deadlineSignal
      });
      if (mmRes.statusCode === 200) {
        const mmData = await mmRes.body.json();
        const rawTr = String(mmData?.responseData?.translatedText || '').replace(/[?!.]+$/g, '');
        if (rawTr && !/MYMEMORY WARNING|PLEASE SELECT TWO DISTINCT/i.test(rawTr)) {
          const trText = restoreEntities(rawTr, placeholders, tl);
          if (trText) {
            queryPoleTranslationCache.set(cacheKey, trText);
            return trText;
          }
        }
      } else if (mmRes.body && typeof mmRes.body.dump === 'function') {
        await mmRes.body.dump().catch(() => {});
      }
    } catch (_) {}
    return '';
  };

  try {
    const [enTr, zhTr, deTr, jaTr, koTr, ruTr] = await Promise.all([
      translateQuick('en'),
      translateQuick('zh-CN'),
      translateQuick('de'),
      translateQuick('ja'),
      translateQuick('ko'),
      translateQuick('ru')
    ]);

    if (enTr) {
      poles.us = enTr;
      poles.usWiki = enTr;
      poles.enCore = enTr;
      poles.academicCore = enTr;
    }
    if (zhTr) {
      poles.cn = zhTr;
      poles.cnWiki = zhTr;
    }
    if (deTr) {
      poles.de = deTr;
      poles.deWiki = deTr;
    }
    if (jaTr) {
      poles.jp = jaTr;
      poles.jpWiki = jaTr;
    }
    if (koTr) {
      poles.kr = koTr;
      poles.krWiki = koTr;
    }
    if (ruTr) {
      poles.ru = ruTr;
      poles.ruWiki = ruTr;
    }
    return poles;
  } finally {
    cleanup();
  }
}

module.exports = {
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_HEADLINE_DEADLINE_MS,
  TtlCache,
  PROTECTED_TECH_BRANDS,
  protectEntities,
  restoreEntities,
  localizeSourceHeadlines,
  enrichMultiPolarQueriesWithTranslation
};
