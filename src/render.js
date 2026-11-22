'use strict';

const { Marked } = require('marked');
const { sanitizeCitations } = require('./llm');
const { escapeHtml, safeHttpUrl } = require('./security');

const POLE_PREFIX_REGEX = /^\[(?:(?:🇺🇸|🇨🇳|🇩🇪|🇯🇵|🇰🇷|🇷🇺|🇧🇷|🌍)\s*)?([A-Z]{2})\]\s*/;

const SUPPORTED_SEARCH_LANGUAGES = [
  { code: 'pt-BR', label: 'Português (BR)' },
  { code: 'en', label: 'English (US)' },
  { code: 'es', label: 'Español (ES)' },
  { code: 'fr', label: 'Français (FR)' },
  { code: 'de', label: 'Deutsch (DE)' },
  { code: 'ja', label: '日本語 (JA)' },
  { code: 'ko', label: '한국어 (KO)' },
  { code: 'zh', label: '中文 (ZH)' },
  { code: 'ru', label: 'Русский (RU)' }
];

/**
 * Renderiza o wordmark "DeepEvil" com direção Obsidian Editorial Técnico
 * (mantendo os spans semânticos compatíveis com a suíte de testes, estilizados
 * via CSS com tinta editorial neutra + acento Cobalt técnico, sem arco-íris).
 */
function renderDeepEvilLogo(sizeClass = 'logo-md') {
  return `<span class="deepevil-wordmark ${escapeHtml(sizeClass)}" aria-label="DeepEvil"><span class="g-blue">D</span><span class="g-red">e</span><span class="g-yellow">e</span><span class="g-blue">p</span><span class="g-green">E</span><span class="g-red">v</span><span class="g-yellow">i</span><span class="g-blue">l</span></span>`;
}

/**
 * Renderiza o monograma geométrico "D" em estética Graphite Dark Sóbria com
 * os 4 quadrantes minerais dessaturados (homenagem Google-Dark com sobriedade).
 */
function renderDeepEvilDIcon(size = 20, clipId = 'deepevil-d-clip') {
  const safeId = escapeHtml(clipId);
  const s = Number(size) || 20;
  return `
    <svg width="${s}" height="${s}" viewBox="0 0 64 64" fill="none" aria-hidden="true" class="deepevil-d-icon" data-icon-id="${safeId}">
      <defs>
        <clipPath id="${safeId}">
          <path fill-rule="evenodd" d="M 14 10 H 32 A 22 22 0 0 1 54 32 A 22 22 0 0 1 32 54 H 14 Z M 24 20 H 32 A 12 12 0 0 1 44 32 A 12 12 0 0 1 32 44 H 24 Z" />
        </clipPath>
      </defs>
      <rect x="2" y="2" width="60" height="60" rx="14" fill="#121216" stroke="#2d2d37" stroke-width="2.5" />
      <g clip-path="url(#${safeId})">
        <polygon fill="#de7368" points="6,4 60,4 52,18 32,32 6,11" />
        <polygon fill="#e2b354" points="6,11 32,32 6,53" />
        <polygon fill="#69b385" points="6,53 32,32 52,46 60,60 6,60" />
        <polygon fill="#7da4e0" points="32,32 52,18 62,18 62,46 52,46" />
      </g>
    </svg>
  `.trim();
}

function formatShortDomain(domain = '') {
  return String(domain || '')
    .trim()
    .replace(/^www\./i, '')
    .slice(0, 28);
}

/**
 * Extrai código ISO limpo do polo (US, CN, DE, JP, KR, RU, BR) e remove prefixos "[🇺🇸 US]"
 * duplicados do título exibido para evitar bandeiras quebradas no Windows ("US US").
 */
function parseSourcePoleAndTitle(rawTitle = '', countryPole = '') {
  const formattedTitle = String(rawTitle || '').replace(
    /\$([^$\n]{1,80})\$/g,
    (_, m) => formatLatexMathInline(m)
  );
  const match = formattedTitle.match(POLE_PREFIX_REGEX);
  const rawPole = match ? match[1] : String(countryPole || '').trim().toUpperCase();
  const iso = /^[A-Z]{2}$/.test(rawPole) ? rawPole : '';
  const cleanTitle = match ? formattedTitle.slice(match[0].length).trim() : formattedTitle.trim();
  return {
    iso,
    rawTitle: formattedTitle,
    cleanTitle: cleanTitle || formattedTitle.trim()
  };
}

function formatRelativeTime(dateStr) {
  if (!dateStr) return '';
  const raw = String(dateStr).trim();
  const isoLike = /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}$/.test(raw)
    ? `${raw.replace(' ', 'T')}Z`
    : raw;
  const parsed = new Date(isoLike);
  if (Number.isNaN(parsed.getTime())) return '';

  const diffMs = Date.now() - parsed.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return 'Agora';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `Há ${diffMin} min`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `Há ${diffHours}h`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) return 'Ontem';
  if (diffDays < 7) return `Há ${diffDays} dias`;
  const dd = String(parsed.getDate()).padStart(2, '0');
  const mm = String(parsed.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}`;
}

function formatLatexMathInline(rawLatex) {
  return String(rawLatex || '')
    .replace(/\\(?:cM|mathcal\{M\})/g, '𝓜')
    .replace(/\\(?:PP|mathbb\{P\})/g, 'ℙ')
    .replace(/\\mathbb\{R\}/g, 'ℝ')
    .replace(/\\mathbb\{Z\}/g, 'ℤ')
    .replace(/\\mathbb\{N\}/g, 'ℕ')
    .replace(/\\mathbb\{C\}/g, 'ℂ')
    .replace(/\\to\b/g, '→')
    .replace(/\\in\b/g, '∈')
    .replace(/\\le(?:q)?\b/g, '≤')
    .replace(/\\ge(?:q)?\b/g, '≥')
    .replace(/\\neq\b/g, '≠')
    .replace(/\\approx\b/g, '≈')
    .replace(/\\times\b/g, '×')
    .replace(/\\infty\b/g, '∞')
    .replace(/\\alpha\b/g, 'α')
    .replace(/\\beta\b/g, 'β')
    .replace(/\\gamma\b/g, 'γ')
    .replace(/\\delta\b/g, 'δ')
    .replace(/\\lambda\b/g, 'λ')
    .replace(/\\sigma\b/g, 'σ')
    .replace(/\\omega\b/g, 'ω')
    .replace(/\\\{/g, '{')
    .replace(/\\\}/g, '}')
    .replace(/\^\{([^}]+)\}/g, '^($1)')
    .replace(/_\{([^}]+)\}/g, '_($1)');
}

/**
 * Fecha virtualmente code fences (``` ou ~~~) que ainda estão abertos durante streaming SSE,
 * evitando lixo visual e saltos de layout (CLS) enquanto o modelo transmite um bloco de código.
 */
function closeUnbalancedFences(markdown) {
  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
  let openFence = null;

  for (const line of lines) {
    const match = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
    if (!match) continue;
    const marker = match[1];
    const rest = match[2] || '';
    if (!openFence) {
      openFence = { char: marker[0], len: marker.length };
    } else if (marker[0] === openFence.char && marker.length >= openFence.len && rest.trim() === '') {
      openFence = null;
    }
  }

  if (openFence) {
    return `${lines.join('\n')}\n${openFence.char.repeat(openFence.len)}`;
  }
  return lines.join('\n');
}

/**
 * Renderiza a faixa horizontal superior de cards de fontes (Sources Strip)
 * logo acima da síntese, conectada às notas de rodapé (#source-{turnId}-{idx}).
 */
function renderTopSourcesStrip(turnId, sources = []) {
  if (!Array.isArray(sources) || sources.length === 0) {
    return '';
  }

  const cardsHtml = sources
    .map((src, i) => {
      const idx = src.citationIndex ?? src.citation_index ?? i + 1;
      const shortHost = formatShortDomain(src.domain);
      const { iso, rawTitle, cleanTitle } = parseSourcePoleAndTitle(src.title, src.countryPole);
      const origHint = src.originalTitle && src.originalTitle !== rawTitle ? ` | Original: ${src.originalTitle}` : '';
      const poleClass = iso ? `pole-${iso.toLowerCase()}` : 'pole-neutral';
      const polePillHtml = iso
        ? `<span class="top-source-pole-tag pole-pill ${poleClass}" data-pole="${escapeHtml(iso)}">${escapeHtml(iso)}</span>`
        : '';

      return `
        <a
          href="#source-${turnId}-${idx}"
          class="top-source-card ${poleClass}"
          data-source-id="source-${turnId}-${idx}"
          title="${escapeHtml(`[${idx}] ${rawTitle} (${src.domain || ''})${origHint}`)}"
        >
          <span class="top-source-card-head">
            <span class="top-source-badge tabular-nums">${idx}</span>
            ${polePillHtml}
            <span class="top-source-domain">${escapeHtml(shortHost)}</span>
          </span>
          <span class="top-source-title">${escapeHtml(cleanTitle)}</span>
        </a>
      `;
    })
    .join('');

  return `
    <div class="top-sources-strip" aria-label="Fontes verificadas da resposta">
      <div class="top-sources-header">
        <span class="top-sources-label">Fontes verificadas <span class="top-sources-count tabular-nums">${sources.length}</span></span>
        <span class="top-sources-sub">Clique em uma fonte para inspecionar o trecho extraído</span>
      </div>
      <div class="top-sources-grid">
        ${cardsHtml}
      </div>
    </div>
  `;
}

/**
 * Renderiza um esqueleto shimmer editorial enquanto o primeiro token ainda não chegou (TTFT).
 */
function renderAnswerSkeleton() {
  return `
    <div class="answer-skeleton" aria-hidden="true">
      <div class="skeleton-header">
        <span class="skeleton-pulse-dot"></span>
        <span class="skeleton-caption">Estruturando síntese verificada e cruzando citações…</span>
      </div>
      <div class="skeleton-line skeleton-line-heading"></div>
      <div class="skeleton-line skeleton-line-full"></div>
      <div class="skeleton-line skeleton-line-lg"></div>
      <div class="skeleton-line skeleton-line-md"></div>
      <div class="skeleton-line skeleton-line-sm"></div>
    </div>
  `.trim();
}

/**
 * Substitui expressões matemáticas inline ($...$) e citações numéricas [1][2]
 * apenas sobre nós de texto fora de `<code>` e `<pre>`.
 */
function injectMathAndCitationsIntoText(escapedText, turnId, validSourcesMap, seenFirstRef) {
  let out = String(escapedText || '');

  // Expressões matemáticas inline $...$
  out = out.replace(/\$([^$\n]{1,80})\$/g, (_, mathBody) => {
    return `<code class="inline-code math-inline">${formatLatexMathInline(mathBody)}</code>`;
  });

  // Citações [1][2] -> Badge numérico compacto [1] + Popover Flutuante WCAG 1.4.13
  out = out.replace(/\[(\d+)\]/g, (_full, numStr) => {
    const idx = Number(numStr);
    const src = validSourcesMap.get(idx);
    if (!src) {
      return '';
    }
    const refIdAttr = !seenFirstRef.has(idx) ? ` id="cite-ref-${turnId}-${idx}"` : '';
    seenFirstRef.add(idx);

    const shortHost = formatShortDomain(src.domain);
    const { iso, cleanTitle } = parseSourcePoleAndTitle(src.title || src.domain || '', src.countryPole);
    const safeSrcUrl = safeHttpUrl(src.url);
    const tooltip = `[${idx}] ${cleanTitle} — ${src.domain || ''}`;
    const hostHiddenSpan = shortHost ? `<span class="citation-host">${escapeHtml(shortHost)}</span>` : '';
    const snippetRaw = String(src.excerpt || '').replace(/\s+/g, ' ').trim();
    const snippetPreview = snippetRaw.slice(0, 175);
    const hasMoreSnippet = snippetRaw.length > 175;
    const polePill = iso
      ? `<span class="pole-pill pole-${escapeHtml(iso.toLowerCase())}">${escapeHtml(iso)}</span>`
      : '';
    const openUrlHtml = safeSrcUrl !== '#'
      ? `<a href="${escapeHtml(safeSrcUrl)}" target="_blank" rel="noopener noreferrer" class="citation-popover-open">Abrir fonte externa ↗</a>`
      : '';

    const popoverHtml = `<span class="citation-popover" role="dialog" aria-label="Prévia da fonte ${idx}" aria-hidden="true" data-citation-popover="${turnId}-${idx}"><span class="citation-popover-head"><span class="citation-popover-badge tabular-nums">[${idx}]</span>${polePill}<span class="citation-popover-domain">${escapeHtml(src.domain || '')}</span></span><span class="citation-popover-title">${escapeHtml(cleanTitle)}</span>${snippetPreview ? `<span class="citation-popover-excerpt">${escapeHtml(snippetPreview)}${hasMoreSnippet ? '…' : ''}</span>` : ''}${openUrlHtml}</span>`;

    return `<sup class="footnote-ref"><a href="#source-${turnId}-${idx}"${refIdAttr} class="citation-link" data-source-id="source-${turnId}-${idx}" aria-label="${escapeHtml(`Fonte ${idx}: ${cleanTitle}`)}" title="${escapeHtml(tooltip)}">[${idx}]${hostHiddenSpan}</a>${popoverHtml}</sup>`;
  });

  return out;
}

/**
 * Converte Markdown da resposta do LLM em HTML seguro usando `marked` com renderer
 * customizado (XSS zero, safeHttpUrl, code fences abertos em streaming, tabelas acessíveis,
 * inline code protegido e citações numéricas compactas com popover flutuante).
 */
function renderAnswerMarkdownWithFootnotes(markdownText, turnId, sources = []) {
  const validSourcesMap = new Map();
  for (let i = 0; i < sources.length; i++) {
    const src = sources[i];
    const cIdx = Number(src?.citationIndex ?? src?.citation_index ?? i + 1);
    if (src && Number.isInteger(cIdx) && cIdx >= 1) {
      validSourcesMap.set(cIdx, { ...src, citationIndex: cIdx });
    }
  }

  const sanitizedMd = sanitizeCitations(markdownText || '', validSourcesMap.size);
  const topStripHtml = renderTopSourcesStrip(turnId, sources);

  if (!sanitizedMd.trim()) {
    return `${topStripHtml}\n${renderAnswerSkeleton()}`.trim();
  }

  // Normaliza cabeçalhos redundantes do LLM e fecha code fences abertos durante streaming
  const cleanedMd = closeUnbalancedFences(
    sanitizedMd
      .replace(/\r\n/g, '\n')
      .replace(
        /^\s*(?:\*\*|#+\s*)?(?:Lead Executivo|S[íi]ntese Executiva|Resumen Ejecutivo|Executive Summary)(?:\*\*)?[:\s—-]*\n+/i,
        ''
      )
  );

  const seenFirstRef = new Set();

  const mdEngine = new Marked({
    gfm: true,
    breaks: false,
    pedantic: false
  });

  mdEngine.use({
    tokenizer: {
      // Impede que linhas "[1]: https://..." do LLM sequestrem as citações [1] verificadas
      def() {
        return undefined;
      }
    },
    renderer: {
      html({ text }) {
        return escapeHtml(text || '');
      },

      code({ text, lang }) {
        const cleanLang = String(lang || '')
          .trim()
          .split(/\s+/)[0]
          .replace(/[^a-zA-Z0-9_+#.-]/g, '')
          .slice(0, 24);
        const langLabel = cleanLang || 'código';
        const langAttr = cleanLang ? ` data-lang="${escapeHtml(cleanLang)}"` : '';
        const codeText = String(text || '').replace(/\n$/, '');

        return `
          <div class="code-block-wrap">
            <div class="code-block-header">
              <span class="code-block-lang">${escapeHtml(langLabel)}</span>
              <button type="button" class="code-copy-btn" data-copy-code="1" aria-label="Copiar código">Copiar código</button>
            </div>
            <pre class="code-block"${langAttr}><code>${escapeHtml(codeText)}</code></pre>
          </div>
        `.trim();
      },

      codespan({ text }) {
        return `<code class="inline-code">${escapeHtml(text || '')}</code>`;
      },

      heading({ tokens, depth }) {
        const level = Math.min(Number(depth || 1) + 2, 6);
        const content = this.parser.parseInline(tokens);
        return `<h${level} class="answer-heading">${content}</h${level}>\n`;
      },

      paragraph({ tokens }) {
        const content = this.parser.parseInline(tokens);
        return `<p class="answer-paragraph">${content}</p>\n`;
      },

      blockquote({ tokens }) {
        const content = this.parser.parse(tokens);
        return `<blockquote class="answer-blockquote">${content}</blockquote>\n`;
      },

      hr() {
        return '<hr class="answer-hr">\n';
      },

      list(token) {
        const tag = token.ordered ? 'ol' : 'ul';
        const startAttr = token.ordered && token.start && token.start !== 1 ? ` start="${Number(token.start)}"` : '';
        const cls = token.ordered ? 'answer-list answer-list-ordered' : 'answer-list';
        let body = '';
        for (let i = 0; i < token.items.length; i++) {
          body += this.listitem(token.items[i]);
        }
        return `<${tag} class="${cls}"${startAttr}>\n${body}</${tag}>\n`;
      },

      listitem(item) {
        let content = '';
        if (item.task) {
          const checkbox = `<input type="checkbox" class="answer-task-checkbox" disabled${item.checked ? ' checked' : ''} aria-label="Item de tarefa"> `;
          if (item.loose && item.tokens.length > 0 && item.tokens[0].type === 'paragraph') {
            content = checkbox + this.parser.parse(item.tokens);
          } else {
            content = checkbox + this.parser.parse(item.tokens);
          }
        } else {
          content = this.parser.parse(item.tokens);
        }
        return `<li>${content}</li>\n`;
      },

      table(token) {
        let headerCells = '';
        for (let i = 0; i < token.header.length; i++) {
          headerCells += this.tablecell(token.header[i]);
        }
        const thead = `<thead><tr>${headerCells}</tr></thead>`;

        let bodyRows = '';
        for (let r = 0; r < token.rows.length; r++) {
          let rowCells = '';
          for (let c = 0; c < token.rows[r].length; c++) {
            rowCells += this.tablecell(token.rows[r][c]);
          }
          bodyRows += `<tr>${rowCells}</tr>`;
        }
        const tbody = bodyRows ? `<tbody>${bodyRows}</tbody>` : '';

        return `<div class="answer-table-wrap" role="region" aria-label="Tabela comparativa" tabindex="0"><table class="answer-table">${thead}${tbody}</table></div>\n`;
      },

      tablecell(cell) {
        const content = this.parser.parseInline(cell.tokens);
        const alignAttr = cell.align && ['left', 'center', 'right'].includes(cell.align)
          ? ` style="text-align:${cell.align}"`
          : '';
        if (cell.header) {
          return `<th scope="col"${alignAttr}>${content}</th>`;
        }
        return `<td${alignAttr}>${content}</td>`;
      },

      link({ href, title, text, tokens, autolink }) {
        const label = autolink ? escapeHtml(text || href || '') : this.parser.parseInline(tokens || []);
        const rawHref = String(href || '').trim();
        const isInternalAnchor = /^#[a-zA-Z0-9_-]+$/.test(rawHref);
        const safeHref = isInternalAnchor ? rawHref : safeHttpUrl(rawHref);
        if (!isInternalAnchor && safeHref === '#') {
          return `<span class="answer-blocked-link">${label}</span>`;
        }
        const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
        if (isInternalAnchor) {
          return `<a href="${escapeHtml(safeHref)}"${titleAttr} class="answer-inline-link">${label}</a>`;
        }
        return `<a href="${escapeHtml(safeHref)}" target="_blank" rel="noopener noreferrer"${titleAttr} class="answer-inline-link">${label}</a>`;
      },

      image({ href, text }) {
        const safeHref = safeHttpUrl(href);
        const altLabel = escapeHtml(text || 'Referência visual');
        if (safeHref === '#') {
          return `<span class="answer-blocked-link">${altLabel}</span>`;
        }
        return `<a href="${escapeHtml(safeHref)}" target="_blank" rel="noopener noreferrer" class="answer-inline-link">${altLabel}</a>`;
      },

      text(token) {
        if (token.tokens && token.tokens.length > 0) {
          return this.parser.parseInline(token.tokens);
        }
        const safeText = token.escaped ? String(token.text || '') : escapeHtml(token.text || '');
        return injectMathAndCitationsIntoText(safeText, turnId, validSourcesMap, seenFirstRef);
      }
    }
  });

  const bodyHtml = String(mdEngine.parse(cleanedMd) || '').trim();
  return `${topStripHtml}\n<div class="answer-prose-content" id="answer-prose-${turnId}">${bodyHtml}</div>`.trim();
}

/**
 * Extrai entidades técnicas, cabeçalhos e subtópicos reais das fontes e do Markdown
 * para gerar perguntas de acompanhamento (Follow-up) específicas ao conteúdo.
 */
function extractKeyConceptsFromTurn(sources = [], answerMarkdown = '', question = '') {
  const concepts = [];
  const lowerQuestion = String(question || '').toLowerCase();
  const seen = new Set();

  const addCandidate = (raw) => {
    const clean = String(raw || '')
      .replace(/\[(\d+)\]/g, '')
      .replace(/[*`#_>|~]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (clean.length < 4 || clean.length > 52) return;
    const key = clean.toLowerCase();
    if (seen.has(key) || key === lowerQuestion) return;
    if (/^(fontes|conclusão|resumo|introdução|visão geral|overview|summary|referências)$/i.test(clean)) return;
    seen.add(key);
    concepts.push(clean);
  };

  // 1. Cabeçalhos ## da resposta gerada
  const headingMatches = String(answerMarkdown || '').matchAll(/^#{2,4}\s+([^\n]+)/gm);
  for (const m of headingMatches) {
    addCandidate(m[1]);
    if (concepts.length >= 3) break;
  }

  // 2. Termos destacados em **negrito** ou `código` na resposta ou nos trechos das fontes
  const boldMatches = String(answerMarkdown || '').matchAll(/\*\*([^*]{4,42})\*\*|`([^`]{3,38})`/g);
  for (const m of boldMatches) {
    addCandidate(m[1] || m[2]);
    if (concepts.length >= 5) break;
  }

  // 3. Títulos limpos das fontes extraídas
  for (const s of sources) {
    if (!s?.title) continue;
    const { cleanTitle } = parseSourcePoleAndTitle(s.title, s.countryPole);
    const shortTitle = cleanTitle.split(/\s+[-—|:]\s+/)[0].trim();
    addCandidate(shortTitle);
    if (concepts.length >= 6) break;
  }

  return concepts;
}

/**
 * Gera perguntas de acompanhamento (Follow-up) dinâmicas orientadas ao conteúdo real
 * das fontes e seções extraídas no idioma da consulta.
 */
function buildContextualFollowUps(question = '', sources = [], answerMarkdown = '') {
  const q = String(question || '').trim();
  const lowerQ = q.toLowerCase();
  const isSpanish =
    /\b(septiembre|qué|cómo|cuáles|atentado|español|historia|cuándo|dónde|por qué)\b/i.test(lowerQ) ||
    sources.some((s) => /\b(espanol|elpais|bbc\.com\/mundo|infobae|rtve)\b/i.test(String(s.url || '')));
  const isEnglish =
    !isSpanish &&
    /\b(what|how|why|when|where|architecture|performance|explained|between)\b/i.test(lowerQ);

  const topic = q.length > 58 ? `${q.slice(0, 55).trim()}…` : (q || 'este tema');
  const concepts = extractKeyConceptsFromTurn(sources, answerMarkdown, q);
  const c1 = concepts[0] || null;
  const c2 = concepts[1] || null;
  const c3 = concepts[2] || null;

  if (isSpanish) {
    return [
      c1
        ? `¿Cómo se relaciona "${c1}" con el desarrollo y las consecuencias de ${topic}?`
        : `¿Cuáles fueron las consecuencias políticas y de seguridad a largo plazo de ${topic}?`,
      c2
        ? `¿Qué detalles clave aportan las fuentes verificadas sobre ${c2}?`
        : `¿Cuál es la cronología detallada y los hechos clave verificados sobre ${topic}?`,
      c3
        ? `¿Qué impacto técnico o histórico tuvo ${c3} según los documentos extraídos?`
        : `¿Qué investigaciones oficiales y medidas se tomaron tras ${topic}?`,
      `¿Cómo impactó ${topic} en la geopolítica y la regulación internacional?`
    ];
  }

  if (isEnglish) {
    return [
      c1
        ? `How does ${c1} impact the architecture and behavior of ${topic}?`
        : `What are the key architectural trade-offs and edge cases of ${topic}?`,
      c2
        ? `Can you provide a deep-dive technical breakdown of ${c2}?`
        : `How does ${topic} compare in real-world benchmarks and production workloads?`,
      c3
        ? `What are the security implications and failure modes involving ${c3}?`
        : `What are the security implications and failure modes of ${topic}?`,
      `How can ${topic} be optimized or mitigated in production environments?`
    ];
  }

  return [
    c1
      ? `Como "${c1}" funciona na prática dentro do contexto de ${topic}?`
      : `Quais são os detalhes técnicos mais críticos e a cronologia completa sobre ${topic}?`,
    c2
      ? `Quais são os mecanismos internos e casos de uso de ${c2}?`
      : `Quais foram as consequências práticas e o impacto de longo prazo de ${topic}?`,
    c3
      ? `Como as fontes extraídas detalham o papel de ${c3}?`
      : `Como as diferentes fontes extraídas comparam as causas e desdobramentos de ${topic}?`,
    `Quais pontos de atenção, falhas ou vulnerabilidades existem em torno de ${topic}?`
  ];
}

/**
 * Renderiza a barra de ações da resposta (somente quando status === 'completed',
 * ou botão de retry quando status === 'error'), sugestões de follow-up e notas de rodapé.
 */
function renderTurnSourcesFootnotes(turnId, sources = [], meta = {}) {
  const status = meta.status || 'completed';

  const retryToolbarHtml =
    status === 'error'
      ? `
        <div class="turn-action-bar turn-error-actions" aria-label="Ações de recuperação">
          <button
            type="button"
            class="turn-action-btn turn-retry-btn"
            data-rewrite-turn="${turnId}"
            data-orig-label="↻ Tentar novamente"
            title="Tentar gerar esta resposta novamente"
          >
            <span class="rewrite-btn-label">↻ Tentar novamente</span>
          </button>
        </div>
      `
      : '';

  if (!sources || sources.length === 0) {
    if (status === 'pending' || status === 'searching' || status === 'extracting') {
      return `
        <div class="sources-loading-skeleton">
          <span class="skeleton-dot" aria-hidden="true"></span>
          <span>Coletando e extraindo fontes verificadas…</span>
        </div>
      `;
    }
    return `
      ${retryToolbarHtml}
      <footer class="turn-footnotes turn-footnotes-empty" aria-label="Fontes da resposta">
        <div class="footnotes-empty-notice">
          Nenhuma fonte web pôde ser extraída com sucesso para esta resposta (alvos inacessíveis foram descartados).
        </div>
      </footer>
    `.trim();
  }

  const followUps = status === 'completed'
    ? buildContextualFollowUps(meta.question || '', sources, meta.answerMarkdown || '')
    : [];

  const followUpsHtml =
    followUps.length > 0
      ? `
        <section class="turn-followups" aria-label="Perguntas de acompanhamento sugeridas">
          <div class="followups-header">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <polyline points="9 18 15 12 9 6"></polyline>
            </svg>
            <h4 class="followups-title">Perguntas de acompanhamento</h4>
          </div>
          <div class="followups-list">
            ${followUps
              .map(
                (fq) => `
              <button type="button" class="followup-chip" data-suggest="${escapeHtml(fq)}">
                <span class="followup-chip-text">${escapeHtml(fq)}</span>
                <span class="followup-chip-arrow" aria-hidden="true">↵</span>
              </button>
            `
              )
              .join('')}
          </div>
        </section>
      `
      : '';

  const translateOptionsHtml = SUPPORTED_SEARCH_LANGUAGES.map(
    (item) => `<option value="${escapeHtml(item.code)}">${escapeHtml(item.label)}</option>`
  ).join('');

  // Gate nativo: actionToolbarHtml só existe quando status === 'completed'
  const actionToolbarHtml =
    status === 'completed'
      ? `
        <div class="turn-action-bar" aria-label="Ações da resposta">
          <button
            type="button"
            class="turn-action-btn"
            data-copy-turn="${turnId}"
            data-orig-label="Copiar"
            title="Copiar resposta limpa para a área de transferência"
          >
            <span class="copy-btn-label">Copiar</span>
          </button>

          <button
            type="button"
            class="turn-action-btn turn-rewrite-btn"
            data-rewrite-turn="${turnId}"
            data-orig-label="↻ Regerar"
            title="Regerar resposta com o modelo selecionado reutilizando as fontes já extraídas"
          >
            <span class="rewrite-btn-label">↻ Regerar</span>
          </button>

          <a
            href="/turns/${turnId}/export.md"
            download="deepevil-turn-${turnId}.md"
            class="turn-action-btn"
            data-export-turn="${turnId}"
            data-export-base="/turns/${turnId}/export.md"
            title="Baixar relatório completo em Markdown (.md) com citações e notas de rodapé"
          >
            <span>Exportar .md</span>
          </a>

          <div class="turn-translate-group" role="group" aria-label="Traduzir resposta">
            <label for="translate-lang-${turnId}" class="sr-only">Idioma para tradução</label>
            <select id="translate-lang-${turnId}" class="turn-translate-select" title="Selecionar idioma de destino">
              ${translateOptionsHtml}
            </select>
            <button
              type="button"
              class="turn-action-btn turn-translate-btn"
              data-translate-turn="${turnId}"
              title="Traduzir esta resposta preservando as citações [1][2]"
            >
              <span class="translate-btn-label">Traduzir</span>
            </button>
            <button
              type="button"
              id="restore-btn-${turnId}"
              class="turn-action-btn turn-restore-btn"
              data-restore-turn="${turnId}"
              hidden
              title="Restaurar resposta no idioma original"
            >
              <span>↺ Original</span>
            </button>
          </div>

          <a href="#source-${turnId}-1" class="turn-action-btn turn-sources-jump" title="Ir para as fontes verificadas">
            <span class="status-dot-inline" aria-hidden="true"></span>
            <span class="tabular-nums">${sources.length} ${sources.length === 1 ? 'fonte verificada' : 'fontes verificadas'}</span>
          </a>
        </div>
      `
      : retryToolbarHtml;

  const itemsHtml = sources
    .map((src, i) => {
      const idx = src.citationIndex ?? src.citation_index ?? i + 1;
      const wordCount = Number(src.wordCount ?? src.word_count ?? 0);
      const sourceAnchorId = `source-${turnId}-${idx}`;
      const backRefHref = `#cite-ref-${turnId}-${idx}`;
      const safeSrcUrl = safeHttpUrl(src.url);
      const { iso, cleanTitle } = parseSourcePoleAndTitle(src.title, src.countryPole);
      const polePill = iso
        ? `<span class="pole-pill pole-${escapeHtml(iso.toLowerCase())}">${escapeHtml(iso)}</span>`
        : '';
      const previewExcerpt = String(src.excerpt || '').slice(0, 420);
      const hasMore = String(src.excerpt || '').length > 420;

      const titleHtml =
        safeSrcUrl !== '#'
          ? `<a href="${escapeHtml(safeSrcUrl)}" target="_blank" rel="noopener noreferrer" class="footnote-link">${escapeHtml(cleanTitle)}</a>`
          : `<span class="footnote-link footnote-link-disabled">${escapeHtml(cleanTitle)}</span>`;

      return `
        <li id="${sourceAnchorId}" class="footnote-item" tabindex="-1">
          <div class="footnote-item-header">
            <a href="${backRefHref}" class="footnote-badge tabular-nums" title="Voltar para a citação [${idx}] no texto">[${idx}]</a>
            <div class="footnote-title-group">
              <div class="serp-cite-line">
                ${polePill}
                <span class="serp-domain-host">${escapeHtml(src.domain || '')}</span>
                <span class="meta-sep" aria-hidden="true">›</span>
                <span class="serp-url-path">${escapeHtml(src.url || '')}</span>
              </div>
              ${titleHtml}
              <div class="footnote-meta">
                <span class="footnote-stats tabular-nums">${wordCount} palavras extraídas</span>
                <span class="meta-sep" aria-hidden="true">·</span>
                <a href="${backRefHref}" class="footnote-backlink" title="Voltar para citação no texto">↩ voltar à citação [${idx}]</a>
              </div>
            </div>
          </div>
          <details class="footnote-excerpt-details">
            <summary class="footnote-excerpt-summary">Ver trecho extraído</summary>
            <blockquote class="footnote-excerpt-text"${safeSrcUrl !== '#' ? ` cite="${escapeHtml(safeSrcUrl)}"` : ''}>
              ${escapeHtml(previewExcerpt)}${hasMore ? '…' : ''}
            </blockquote>
          </details>
        </li>
      `;
    })
    .join('\n');

  return `
    ${actionToolbarHtml}
    ${followUpsHtml}
    <footer class="turn-footnotes" aria-label="Fontes e notas de rodapé da resposta">
      <div class="footnotes-header">
        <div class="footnotes-heading-wrap">
          <svg class="icon-svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path>
            <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path>
          </svg>
          <h4 class="footnotes-title">Fontes verificadas</h4>
        </div>
        <span class="footnotes-count tabular-nums">${sources.length} ${sources.length === 1 ? 'fonte' : 'fontes'}</span>
      </div>
      <ol class="footnotes-list">
        ${itemsHtml}
      </ol>
    </footer>
  `.trim();
}

/**
 * Renderiza o stepper progressivo de 4 fases (Buscando → Extraindo → Sintetizando → Concluído),
 * cronômetro vivo em tabular-nums e botão de interrupção em alto contraste AA.
 */
function renderPipelineStatusBadge(status, details = {}) {
  const phaseIndexMap = {
    pending: 0,
    searching: 0,
    extracting: 1,
    streaming: 2,
    completed: 3,
    error: -1
  };
  const currentPhaseIdx = Object.prototype.hasOwnProperty.call(phaseIndexMap, status)
    ? phaseIndexMap[status]
    : 0;

  const extracted = Number(details.extractedCount || 0);
  const attempted = Number(details.attemptedCount || 0);
  const durationSec = details.durationMs ? `${(Number(details.durationMs) / 1000).toFixed(1)}s` : '';

  const labelMap = {
    pending: 'Preparando pesquisa…',
    searching: 'Buscando fontes…',
    extracting: `Extraindo ${attempted > 0 ? attempted : 'as'} páginas…`,
    streaming: `Sintetizando resposta…${extracted > 0 ? ` (${extracted} ${extracted === 1 ? 'fonte' : 'fontes'})` : ''}${details.model ? ` · ${escapeHtml(details.model)}` : ''}`,
    completed: `${extracted}${attempted > 0 ? `/${attempted}` : ''} fontes verificadas${details.model ? ` · ${escapeHtml(details.model)}` : ''}${durationSec ? ` · ${durationSec}` : ''}`,
    error: `Falha no processamento: ${escapeHtml(details.errorMessage || 'erro inesperado')}`
  };

  const stateClass =
    status === 'completed'
      ? 'status-completed'
      : status === 'error'
      ? 'status-error'
      : 'status-active';

  const isRunning =
    status === 'pending' || status === 'searching' || status === 'extracting' || status === 'streaming';

  const steps = ['Buscando', 'Extraindo', 'Sintetizando', 'Concluído'];
  const stepperHtml =
    status !== 'error'
      ? `<ol class="pipeline-stepper" aria-hidden="true">${steps
          .map((label, idx) => {
            let cls = 'step-upcoming';
            if (status === 'completed' || idx < currentPhaseIdx) cls = 'step-done';
            else if (idx === currentPhaseIdx) cls = 'step-active';
            return `<li class="pipeline-step ${cls}"><span class="pipeline-step-dot"></span><span>${label}</span></li>`;
          })
          .join('')}</ol>`
      : '';

  const liveTimerHtml = isRunning
    ? `<span class="pipeline-live-timer tabular-nums" data-live-timer="${escapeHtml(details.turnId || '')}">0.0s</span>`
    : '';

  const stopBtnHtml =
    isRunning && details.turnId
      ? `<button type="button" class="pipeline-stop-btn" data-stop-turn="${escapeHtml(details.turnId)}" title="Interromper geração imediatamente">■ Parar</button>`
      : '';

  const progressPctMap = {
    pending: 12,
    searching: 28,
    extracting: 62,
    streaming: 88,
    completed: 100
  };
  const progressPct = progressPctMap[status] || 0;

  const subHintMap = {
    pending: 'Inicializando pipeline de busca multipolar…',
    searching: 'Consultando índices globais (US · CN · DE · JP · KR · RU · BR) e filtrando relevância…',
    extracting: 'Extraindo texto principal das páginas com Readability (Early-Cutoff ativo)…',
    streaming: 'Cruzando evidências verificadas e redigindo síntese com citações inline [1]…'
  };
  const subHintText = isRunning ? (subHintMap[status] || '') : '';
  const subHintHtml = subHintText
    ? `<div class="pipeline-subhint">${escapeHtml(subHintText)}</div>`
    : '';

  const progressBarHtml = isRunning
    ? `<div class="pipeline-progress-track" role="progressbar" aria-label="Progresso da pesquisa e síntese" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progressPct}"><div class="pipeline-progress-fill" style="width: ${progressPct}%"></div></div>`
    : '';

  const text = labelMap[status] || labelMap.pending;

  return `
    <div class="pipeline-status ${stateClass}" data-status="${escapeHtml(status)}">
      <div class="pipeline-status-main">
        <span class="status-indicator" aria-hidden="true"></span>
        <span class="status-text tabular-nums">${text}</span>
        ${liveTimerHtml}
        ${stopBtnHtml}
      </div>
      ${subHintHtml}
      ${stepperHtml}
      ${progressBarHtml}
    </div>
  `.trim();
}

/**
 * Renderiza um turno completo (Pergunta + Pipeline Stepper + Síntese + Fontes).
 * Usa `data-stream-turn` como contrato único para o EventSource em `public/app.js`
 * (zero `htmx-ext-sse`, zero conexões duplicadas).
 */
function renderTurnCard(turn, options = {}) {
  const isLive = Boolean(
    options.isLive ||
      turn.status === 'pending' ||
      turn.status === 'searching' ||
      turn.status === 'extracting' ||
      turn.status === 'streaming'
  );
  const sources = Array.isArray(turn.sources) ? turn.sources : [];
  const headingTag = options.isPrimaryHeading ? 'h1' : 'h2';

  const statusHtml = renderPipelineStatusBadge(turn.status, {
    turnId: turn.id,
    searchQuery: turn.search_query,
    attemptedCount: turn.attempted_urls_count,
    extractedCount: turn.extracted_sources_count || sources.length,
    provider: turn.provider,
    model: turn.model,
    durationMs: turn.duration_ms,
    errorMessage: turn.error_message
  });

  const answerHtml =
    turn.status === 'error'
      ? `<div class="turn-error-box" role="alert"><strong>Falha na síntese:</strong> ${escapeHtml(turn.error_message)}</div>`
      : renderAnswerMarkdownWithFootnotes(turn.answer_markdown, turn.id, sources);

  const sourcesHtml = renderTurnSourcesFootnotes(turn.id, sources, {
    status: turn.status,
    question: turn.question,
    answerMarkdown: turn.answer_markdown
  });

  const streamAttr = isLive ? ` data-stream-turn="${turn.id}"` : '';
  const innerContent = `
    <div id="sse-container-${turn.id}" class="turn-stream-wrapper"${streamAttr}>
      <div id="turn-status-${turn.id}" class="turn-status-slot" role="status" aria-live="polite" aria-atomic="true">
        ${statusHtml}
      </div>

      <section id="turn-answer-${turn.id}" class="turn-answer-body" aria-busy="${isLive ? 'true' : 'false'}">
        ${answerHtml}
      </section>

      <div id="turn-sources-${turn.id}" class="turn-sources-slot">
        ${sourcesHtml}
      </div>
    </div>
  `;

  const scopeKey = String(turn.search_scope || 'global').trim().toLowerCase();
  const scopeLabelMap = {
    global: 'Global · 7 polos',
    external: 'Externo · 6 polos',
    brazil: 'Brasil'
  };
  const scopeBadgeHtml = `<span class="turn-scope-badge" data-scope="${escapeHtml(scopeKey)}">${escapeHtml(scopeLabelMap[scopeKey] || scopeLabelMap.global)}</span>`;

  const langKey = String(turn.search_lang || 'pt-BR').trim();
  const langBadgeHtml = `<span class="turn-lang-badge" data-lang="${escapeHtml(langKey)}" title="Idioma selecionado para tradução de headlines e síntese">Headlines &amp; Síntese: ${escapeHtml(langKey.toUpperCase())}</span>`;

  const expandedQueryHtml =
    turn.search_query && turn.search_query !== turn.question
      ? `
        <details class="query-details">
          <summary class="query-details-summary">Ver consulta expandida</summary>
          <code class="query-details-code">${escapeHtml(turn.search_query)}</code>
        </details>
      `
      : '';

  return `
    <article id="turn-${turn.id}" class="turn-card${isLive ? ' turn-card-live' : ''}" data-turn-id="${turn.id}">
      <header class="turn-question-header">
        <${headingTag} class="turn-question-title">${escapeHtml(turn.question)}</${headingTag}>
        <div class="turn-question-meta">
          ${scopeBadgeHtml}
          ${langBadgeHtml}
          ${expandedQueryHtml}
        </div>
      </header>
      ${innerContent}
    </article>
  `.trim();
}

/**
 * Renderiza a lista de conversas na barra lateral, com timestamps relativos,
 * filtro instantâneo via data-search-title e confirmação segura no delete.
 */
function renderSidebarConversations(conversations = [], activeConversationId = null, isOob = false) {
  const oobAttr = isOob ? ' hx-swap-oob="true"' : '';

  if (!conversations || conversations.length === 0) {
    return `
      <nav id="sidebar-conversations" class="sidebar-nav"${oobAttr} aria-label="Conversas anteriores">
        <div class="sidebar-empty">
          Nenhuma pesquisa salva ainda. Faça sua primeira pergunta no campo principal.
        </div>
      </nav>
    `.trim();
  }

  const items = conversations
    .map((conv) => {
      const isActive = Number(conv.id) === Number(activeConversationId);
      const activeClass = isActive ? ' sidebar-item-active' : '';
      const ariaCurrent = isActive ? ' aria-current="page"' : '';
      const turnCount = Number(conv.turn_count || 1);
      const relTime = formatRelativeTime(conv.updated_at || conv.created_at);
      const metaParts = [
        relTime || null,
        `${turnCount} ${turnCount === 1 ? 'turno' : 'turnos'}`
      ].filter(Boolean);

      return `
        <div class="sidebar-item-row${activeClass}" data-search-title="${escapeHtml(String(conv.title || '').toLowerCase())}">
          <a
            href="/c/${conv.id}"
            hx-get="/conversations/${conv.id}"
            hx-target="#main-stage"
            hx-push-url="/c/${conv.id}"
            class="sidebar-item-link"${ariaCurrent}
            title="${escapeHtml(conv.title)}"
          >
            <span class="sidebar-item-title">${escapeHtml(conv.title)}</span>
            <span class="sidebar-item-meta tabular-nums">${escapeHtml(metaParts.join(' · '))}</span>
          </a>
          <button
            type="button"
            class="sidebar-delete-btn"
            hx-delete="/conversations/${conv.id}"
            hx-confirm="Excluir esta pesquisa permanentemente?"
            hx-target="#sidebar-conversations"
            hx-swap="outerHTML"
            aria-label="Excluir conversa: ${escapeHtml(conv.title)}"
            title="Excluir pesquisa"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M3 6h18"></path>
              <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path>
              <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path>
            </svg>
          </button>
        </div>
      `;
    })
    .join('\n');

  return `
    <nav id="sidebar-conversations" class="sidebar-nav"${oobAttr} aria-label="Conversas anteriores">
      ${items}
      <div id="sidebar-no-matches" class="sidebar-empty" hidden>Nenhuma pesquisa encontrada para o filtro.</div>
    </nav>
  `.trim();
}

/**
 * Renderiza o banner de contexto ativo (isolado em #composer-context-slot para
 * permitir OOB update em POST /ask sem destruir o foco do composer).
 */
function renderComposerContextSlot(activeConversation = null, isOob = false) {
  const oobAttr = isOob ? ' hx-swap-oob="true"' : '';
  const hasConv = Boolean(activeConversation?.id);

  if (!hasConv) {
    return `<div id="composer-context-slot"${oobAttr}></div>`;
  }

  return `
    <div id="composer-context-slot"${oobAttr}>
      <div class="composer-context-bar">
        <span class="context-pill">
          <span class="context-dot" aria-hidden="true"></span>
          <span>Contexto ativo · <strong>${escapeHtml(activeConversation.title)}</strong></span>
        </span>
        <a
          href="/"
          hx-get="/new"
          hx-target="#main-stage"
          hx-push-url="/"
          class="context-reset-link"
        >Nova pesquisa</a>
      </div>
    </div>
  `.trim();
}

/**
 * Renderiza o Composer Command Deck (2-Tier Obsidian Editorial) com Combobox
 * pesquisável para 81+ modelos Ollama, selects sem truncamento, persistência e
 * drawer de opções compacto no mobile (390px).
 */
function renderComposerForm(activeConversation = null, isOob = false, options = {}) {
  const oobAttr = isOob ? ' hx-swap-oob="true"' : '';
  const convId = activeConversation?.id ? String(activeConversation.id) : '';
  const isFollowUp = Boolean(convId);

  const rawModels = Array.isArray(options.models) && options.models.length > 0
    ? options.models
    : [{ name: options.activeModel || 'granite4.2:latest', parameterSize: 'Local' }];

  const selectedModelName = options.activeModel || rawModels[0]?.name || 'granite4.2:latest';

  const modelOptionsHtml = rawModels
    .map((m) => {
      const modelName = typeof m === 'string' ? m : m.name;
      const rawBadge = typeof m === 'object'
        ? (m.parameterSize || (m.sizeGb ? (m.sizeGb === 'Cloud' ? 'Cloud' : `${m.sizeGb}GB`) : ''))
        : '';
      const paramSize = rawBadge ? ` (${rawBadge})` : '';
      const isSelected = modelName === selectedModelName ? ' selected' : '';
      return `<option value="${escapeHtml(modelName)}"${isSelected}>${escapeHtml(modelName)}${escapeHtml(paramSize)}</option>`;
    })
    .join('');

  const placeholder = isFollowUp
    ? 'Faça uma pergunta de acompanhamento (mantém o contexto)…'
    : 'Pergunte qualquer tema técnico, científico ou geopolítico…';

  const activeScope = options.activeScope || 'global';
  const activeLang = options.activeLang || 'pt-BR';
  const activeFocus = options.activeFocus || 'web';

  const langOptionsHtml = SUPPORTED_SEARCH_LANGUAGES.map(
    (item) => `<option value="${escapeHtml(item.code)}"${activeLang === item.code ? ' selected' : ''}>${escapeHtml(item.label)}</option>`
  ).join('');

  return `
    <div id="composer-region" class="composer-region"${oobAttr}>
      ${renderComposerContextSlot(activeConversation, false)}
      <div id="composer-error-slot" class="composer-error-slot" role="alert" aria-live="assertive" hidden></div>
      <form
        id="ask-form"
        class="composer-form composer-command-deck"
        action="/ask"
        method="POST"
        hx-post="/ask"
        hx-target="#conversation-turns"
        hx-swap="beforeend"
        hx-disabled-elt="#ask-submit-btn, #question-input"
      >
        <input type="hidden" name="conversationId" id="active-conversation-id" value="${escapeHtml(convId)}">

        <!-- TIER 1: Full-Width Input Row -->
        <div class="composer-input-row">
          <span class="composer-search-icon" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="11" cy="11" r="8"></circle>
              <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
            </svg>
          </span>

          <div class="growable-textarea composer-input-wrap" data-replicated-value="">
            <label for="question-input" class="sr-only">Pesquisar no DeepEvil</label>
            <textarea
              id="question-input"
              name="question"
              rows="1"
              required
              maxlength="2000"
              placeholder="${escapeHtml(placeholder)}"
              class="composer-textarea"
            ></textarea>
          </div>

          <button
            type="button"
            id="mobile-options-toggle"
            class="mobile-options-btn"
            aria-expanded="false"
            aria-controls="composer-control-deck"
            title="Abrir opções de escopo, idioma, foco e modelo"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <line x1="4" y1="21" x2="4" y2="14"></line>
              <line x1="4" y1="10" x2="4" y2="3"></line>
              <line x1="12" y1="21" x2="12" y2="12"></line>
              <line x1="12" y1="8" x2="12" y2="3"></line>
              <line x1="20" y1="21" x2="20" y2="16"></line>
              <line x1="20" y1="12" x2="20" y2="3"></line>
              <line x1="1" y1="14" x2="7" y2="14"></line>
              <line x1="9" y1="8" x2="15" y2="8"></line>
              <line x1="17" y1="16" x2="23" y2="16"></line>
            </svg>
            <span>Opções</span>
          </button>

          <button type="submit" id="ask-submit-btn" class="composer-submit-btn" title="Executar pesquisa">
            <span id="ask-submit-label">${isFollowUp ? 'Follow-up' : 'Pesquisar'}</span>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <line x1="5" y1="12" x2="19" y2="12"></line>
              <polyline points="12 5 19 12 12 19"></polyline>
            </svg>
          </button>
        </div>

        <!-- TIER 2: Tactical Control Deck -->
        <div id="composer-control-deck" class="composer-control-deck">
          <div class="composer-tactical-group">
            <!-- 1. Escopo Geográfico -->
            <div class="scope-selector-wrap tactical-control-pill pill-scope" title="Escopo Geográfico: Global · 7 Polos (US·CN·DE·JP·KR·RU·BR), Externo · 6 polos ou Brasil">
              <svg class="tactical-pill-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="2" y1="12" x2="22" y2="12"></line>
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>
              </svg>
              <label for="scope-select" class="tactical-pill-kicker">Escopo</label>
              <select id="scope-select" name="searchScope" class="tactical-select">
                <option value="global"${activeScope === 'global' ? ' selected' : ''}>Global · 7 polos</option>
                <option value="external"${activeScope === 'external' ? ' selected' : ''}>Externo · 6 polos</option>
                <option value="brazil"${activeScope === 'brazil' ? ' selected' : ''}>Brasil</option>
              </select>
            </div>

            <!-- 2. Seletor de Idioma -->
            <div class="lang-selector-wrap tactical-control-pill pill-lang" title="Idioma das headlines e síntese da resposta">
              <svg class="tactical-pill-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="m5 8 6 6"></path>
                <path d="m4 14 6-6 2-3"></path>
                <path d="M2 5h12"></path>
                <path d="M7 2h1"></path>
                <path d="m22 22-5-10-5 10"></path>
                <path d="M14 18h6"></path>
              </svg>
              <label for="lang-select" class="tactical-pill-kicker">Idioma</label>
              <select id="lang-select" name="searchLang" class="tactical-select">
                ${langOptionsHtml}
              </select>
            </div>

            <!-- 3. Modo de Foco -->
            <div class="focus-selector-wrap tactical-control-pill pill-focus" title="Modo de foco técnico da pesquisa">
              <svg class="tactical-pill-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="10"></circle>
                <circle cx="12" cy="12" r="6"></circle>
                <circle cx="12" cy="12" r="2"></circle>
              </svg>
              <label for="focus-select" class="tactical-pill-kicker">Foco</label>
              <select id="focus-select" name="focusMode" class="tactical-select">
                <option value="web"${activeFocus === 'web' ? ' selected' : ''}>Web Global</option>
                <option value="secops"${activeFocus === 'secops' ? ' selected' : ''}>SecOps / CVE</option>
                <option value="code"${activeFocus === 'code' ? ' selected' : ''}>Code / Docs</option>
                <option value="academic"${activeFocus === 'academic' ? ' selected' : ''}>Academic</option>
                <option value="hybrid"${activeFocus === 'hybrid' ? ' selected' : ''}>Híbrido (Local + Web)</option>
              </select>
            </div>
          </div>

          <div class="composer-meta-group">
            <!-- 4. Combobox Pesquisável para Modelos Ollama (com <select id="model-select"> sincronizado) -->
            <div class="model-selector-wrap tactical-control-pill pill-model" id="model-combobox-wrap">
              <svg class="tactical-pill-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <rect x="4" y="4" width="16" height="16" rx="2"></rect>
                <rect x="9" y="9" width="6" height="6"></rect>
                <path d="M15 2v2"></path>
                <path d="M15 20v2"></path>
                <path d="M2 15h2"></path>
                <path d="M2 9h2"></path>
                <path d="M20 15h2"></path>
                <path d="M20 9h2"></path>
                <path d="M9 2v2"></path>
                <path d="M9 20v2"></path>
              </svg>
              <label for="model-combobox-input" class="tactical-pill-kicker">Modelo</label>
              <select id="model-select" name="model" class="sr-only-select" aria-hidden="true" tabindex="-1" data-active-model="${escapeHtml(selectedModelName)}">
                ${modelOptionsHtml}
              </select>
              <div class="model-combobox">
                <input
                  type="text"
                  id="model-combobox-input"
                  class="model-combobox-input"
                  role="combobox"
                  autocomplete="off"
                  spellcheck="false"
                  aria-autocomplete="list"
                  aria-expanded="false"
                  aria-controls="model-combobox-listbox"
                  aria-label="Selecionar ou filtrar modelo Ollama"
                  value="${escapeHtml(selectedModelName)}"
                  placeholder="Filtrar modelos…"
                >
                <button
                  type="button"
                  id="model-combobox-toggle"
                  class="model-combobox-chevron"
                  tabindex="-1"
                  aria-label="Abrir lista de modelos"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <polyline points="6 9 12 15 18 9"></polyline>
                  </svg>
                </button>
                <div
                  id="model-combobox-popover"
                  class="model-combobox-popover"
                  hidden
                >
                  <div class="model-combobox-meta tabular-nums" id="model-combobox-count"></div>
                  <ul
                    id="model-combobox-listbox"
                    class="model-combobox-listbox"
                    role="listbox"
                    aria-label="Modelos Ollama disponíveis"
                  ></ul>
                </div>
              </div>
            </div>

            <span class="composer-hint" aria-hidden="true">
              <kbd>/</kbd> buscar · <kbd>Enter</kbd> enviar
            </span>
          </div>
        </div>
      </form>
    </div>
  `.trim();
}

/**
 * Renderiza o palco principal (#main-stage):
 * - Home vazia (.stage-empty): wordmark centralizado + subtítulo + Composer imediatamente abaixo + chips.
 * - Thread (.stage-thread): header enxuto + cards de turnos + composer ancorado no rodapé.
 */
function renderMainStage(activeConversation = null, envStatus = {}) {
  const turns = Array.isArray(activeConversation?.turns) ? activeConversation.turns : [];
  const hasTurns = turns.length > 0;
  const stageModeClass = hasTurns ? 'stage-thread' : 'stage-empty';

  const emptyHero = !hasTurns
    ? `
      <div id="empty-hero" class="empty-hero">
        <h1 class="hero-brand-heading">
          ${renderDeepEvilLogo('logo-xl')}
        </h1>
        <p class="hero-subtitle">Pesquisa multipolar local com síntese verificada e citações rastreáveis.</p>
      </div>
    `
    : '';

  const heroSuggestions = !hasTurns
    ? `
      <div id="hero-suggestions" class="hero-suggestions" aria-label="Sugestões rápidas de pesquisa">
        <button type="button" class="suggestion-chip" data-suggest="Como funcionam rootkits de kernel Linux via ftrace e como detectá-los?">
          Linux kernel ftrace &amp; detecção
        </button>
        <button type="button" class="suggestion-chip" data-suggest="Quais as diferenças práticas entre Server-Sent Events (SSE) e WebSockets para streaming de baixa latência?">
          SSE vs WebSockets em produção
        </button>
        <button type="button" class="suggestion-chip" data-suggest="Como o Mozilla Readability identifica o conteúdo principal de um artigo HTML?">
          Algoritmo Mozilla Readability
        </button>
      </div>
    `
    : '';

  const turnsHtml = turns
    .map((turn, idx) =>
      renderTurnCard(turn, {
        isLive: turn.status === 'pending',
        isPrimaryHeading: idx === 0
      })
    )
    .join('\n');

  const topBar = `
    <header class="stage-topbar" aria-label="Navegação superior">
      <div class="topbar-left">
        <button
          type="button"
          id="mobile-menu-btn"
          class="topbar-icon-btn mobile-only-btn"
          aria-controls="app-sidebar"
          aria-expanded="false"
          aria-label="Abrir histórico de pesquisas"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <line x1="3" y1="6" x2="21" y2="6"></line>
            <line x1="3" y1="12" x2="21" y2="12"></line>
            <line x1="3" y1="18" x2="21" y2="18"></line>
          </svg>
        </button>
        <button
          type="button"
          id="sidebar-expand-btn"
          class="topbar-icon-btn desktop-expand-btn"
          aria-controls="app-sidebar"
          aria-expanded="true"
          aria-label="Expandir barra lateral"
          title="Expandir barra lateral"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="3" y="3" width="18" height="18" rx="2"></rect>
            <line x1="9" y1="3" x2="9" y2="21"></line>
          </svg>
        </button>
        <span class="topbar-mobile-brand mobile-only-brand" aria-hidden="true">DeepEvil</span>
      </div>
      <div class="topbar-right">
        <span class="topbar-model-pill" id="top-bar-llm-badge">
          <span class="status-dot-inline" aria-hidden="true"></span>
          <span class="topbar-model-name">${escapeHtml(envStatus.model || 'granite4.2:latest')}</span>
        </span>
      </div>
    </header>
  `;

  return `
    <div id="stage-shell" class="stage-shell ${stageModeClass}">
      ${topBar}
      <div class="stage-content-wrap">
        <div id="conversation-scroll" class="conversation-scroll">
          ${emptyHero}
          <div id="conversation-turns" class="conversation-turns">
            ${turnsHtml}
          </div>
        </div>
        ${renderComposerForm(activeConversation, false, {
          models: envStatus.models || [],
          activeModel: envStatus.model || ''
        })}
        ${heroSuggestions}
      </div>
    </div>
  `.trim();
}

/**
 * Renderiza o documento HTML completo da aplicação DeepEvil (Obsidian Editorial Técnico, WCAG 2.1 AA).
 */
function renderFullPage({ conversations = [], activeConversation = null, envStatus = {} }) {
  const pageTitle = activeConversation?.title
    ? `${activeConversation.title} — DeepEvil`
    : 'DeepEvil';

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(pageTitle)}</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg?v=deepevil-9">
  <link rel="shortcut icon" href="/favicon.ico?v=deepevil-9">
  <link rel="stylesheet" href="/styles.css?v=deepevil-9">
  <script src="/vendor/htmx.min.js" defer></script>
  <script src="/app.js?v=deepevil-9" defer></script>
</head>
<body>
  <a href="#main-stage" class="skip-link">Pular para o conteúdo principal</a>

  <div id="sidebar-backdrop" class="sidebar-backdrop" hidden></div>

  <div id="app-shell" class="app-shell">
    <!-- Barra Lateral: Histórico de Pesquisas -->
    <aside id="app-sidebar" class="app-sidebar" aria-label="Histórico de pesquisas">
      <div class="sidebar-header">
        <div class="sidebar-brand-row">
          <a
            href="/"
            hx-get="/new"
            hx-target="#main-stage"
            hx-push-url="/"
            class="brand-logo"
          >
            <span class="brand-mark" aria-hidden="true">
              ${renderDeepEvilDIcon(24, 'sidebar-d-clip')}
            </span>
            <span class="brand-text">
              ${renderDeepEvilLogo('logo-sm')}
            </span>
          </a>

          <button
            type="button"
            id="sidebar-collapse-btn"
            class="sidebar-collapse-btn"
            aria-label="Recolher barra lateral"
            title="Recolher barra lateral"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <polyline points="15 18 9 12 15 6"></polyline>
            </svg>
          </button>

          <button
            type="button"
            id="mobile-close-drawer-btn"
            class="sidebar-collapse-btn mobile-only-close"
            aria-label="Fechar histórico de pesquisas"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>

        <a
          href="/"
          hx-get="/new"
          hx-target="#main-stage"
          hx-push-url="/"
          class="new-thread-btn"
          title="Iniciar uma nova pesquisa"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <line x1="12" y1="5" x2="12" y2="19"></line>
            <line x1="5" y1="12" x2="19" y2="12"></line>
          </svg>
          <span>Nova Pesquisa</span>
        </a>

        <div class="sidebar-search-wrap">
          <svg class="sidebar-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="8"></circle>
            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
          </svg>
          <label for="sidebar-search-input" class="sr-only">Filtrar histórico de pesquisas</label>
          <input
            type="search"
            id="sidebar-search-input"
            class="sidebar-search-input"
            placeholder="Filtrar histórico…"
            autocomplete="off"
          >
        </div>
      </div>

      <div class="sidebar-section-label">
        <span>Histórico</span>
        <span class="sidebar-count tabular-nums" id="sidebar-total-count">${conversations.length}</span>
      </div>

      ${renderSidebarConversations(conversations, activeConversation?.id, false)}

      <div class="sidebar-footer">
        <div class="privacy-badge">
          <span class="privacy-dot" aria-hidden="true"></span>
          <span>Local · <code>127.0.0.1:3000</code></span>
        </div>
      </div>
    </aside>

    <!-- Palco Principal DeepEvil -->
    <main id="main-stage" class="app-main" tabindex="-1">
      ${renderMainStage(activeConversation, envStatus)}
    </main>
  </div>
</body>
</html>`;
}

module.exports = {
  escapeHtml,
  renderDeepEvilLogo,
  renderDeepEvilDIcon,
  renderTopSourcesStrip,
  extractKeyConceptsFromTurn,
  buildContextualFollowUps,
  renderAnswerMarkdownWithFootnotes,
  renderTurnSourcesFootnotes,
  renderPipelineStatusBadge,
  renderTurnCard,
  renderSidebarConversations,
  renderComposerContextSlot,
  renderComposerForm,
  renderMainStage,
  renderFullPage
};
