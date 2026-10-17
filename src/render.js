'use strict';

const { sanitizeCitations } = require('./llm');

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Renderiza o wordmark "DeepEvil" com a sequência clássica das 4 cores do Google
 * (Azul #4285F4, Vermelho #EA4335, Amarelo #FBBC05, Verde #34A853) + estética Google Hacker.
 */
function renderDeepEvilLogo(sizeClass = 'logo-md') {
  return `<span class="deepevil-wordmark ${escapeHtml(sizeClass)}" aria-label="DeepEvil"><span class="g-blue">D</span><span class="g-red">e</span><span class="g-yellow">e</span><span class="g-blue">p</span><span class="g-green">E</span><span class="g-red">v</span><span class="g-yellow">i</span><span class="g-blue">l</span></span>`;
}

/**
 * Renderiza o ícone "D" nas 4 cores do Google (estilo Google "G" oficial, mas com a letra D).
 */
function renderDeepEvilDIcon(size = 22, clipId = 'deepevil-d-clip') {
  const safeId = escapeHtml(clipId);
  const s = Number(size) || 22;
  return `
    <svg width="${s}" height="${s}" viewBox="0 0 64 64" aria-hidden="true" class="deepevil-d-icon">
      <defs>
        <clipPath id="${safeId}">
          <path fill-rule="evenodd" d="M 12 8 H 32 A 24 24 0 0 1 56 32 A 24 24 0 0 1 32 56 H 12 Z M 23 19 H 32 A 13 13 0 0 1 45 32 A 13 13 0 0 1 32 45 H 23 Z" />
        </clipPath>
      </defs>
      <g clip-path="url(#${safeId})">
        <polygon fill="#EA4335" points="6,4 60,4 52,18 32,32 6,11" />
        <polygon fill="#FBBC05" points="6,11 32,32 6,53" />
        <polygon fill="#34A853" points="6,53 32,32 52,46 60,60 6,60" />
        <polygon fill="#4285F4" points="32,32 52,18 62,18 62,46 52,46" />
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
 * Renderiza a faixa horizontal superior de cards de fontes (estilo Perplexity Sources Strip)
 * logo acima da síntese executiva, conectada às notas de rodapé (#source-{turnId}-{idx}).
 */
function renderTopSourcesStrip(turnId, sources = []) {
  if (!Array.isArray(sources) || sources.length === 0) {
    return '';
  }

  const cardsHtml = sources
    .map((src, i) => {
      const idx = src.citationIndex ?? src.citation_index ?? i + 1;
      const shortHost = formatShortDomain(src.domain);
      const colorCycle = ['g-top-blue', 'g-top-red', 'g-top-yellow', 'g-top-green'][(idx - 1) % 4];
      return `
        <a
          href="#source-${turnId}-${idx}"
          class="top-source-card ${colorCycle}"
          data-source-id="source-${turnId}-${idx}"
          title="${escapeHtml(`[${idx}] ${src.title} (${src.domain})`)}"
        >
          <span class="top-source-card-head">
            <span class="top-source-badge tabular-nums">[${idx}]</span>
            <span class="top-source-domain">${escapeHtml(shortHost)}</span>
          </span>
          <span class="top-source-title">${escapeHtml(src.title)}</span>
        </a>
      `;
    })
    .join('');

  return `
    <div class="top-sources-strip" aria-label="Fontes verificadas da resposta">
      <div class="top-sources-header">
        <span class="top-sources-label">
          <span class="g-green">●</span> Fontes Verificadas (${sources.length})
        </span>
        <span class="top-sources-sub">Readability DOM · Clique para inspecionar rodapé</span>
      </div>
      <div class="top-sources-grid">
        ${cardsHtml}
      </div>
    </div>
  `;
}

/**
 * Converte Markdown da resposta do LLM em HTML seguro e transforma todas as
 * citações [1][2] em links de rodapé clicáveis (#source-{turnId}-{index})
 * com badge do domínio confiável e faixa superior de cards de fontes.
 *
 * Nunca gera link para uma fonte que não esteja presente em `sources`.
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
  if (!sanitizedMd.trim()) {
    return '<p class="answer-placeholder">[SYS::STREAM] Sintetizando pacotes de leitura verificada…</p>';
  }

  // Separa blocos de código cercados (```) para não processar citações dentro de código literal
  const segments = sanitizedMd.split(/(```[\s\S]*?```)/g);
  const seenFirstRef = new Set();

  const htmlSegments = segments.map((segment) => {
    if (segment.startsWith('```') && segment.endsWith('```')) {
      const lines = segment.slice(3, -3).trim().split('\n');
      const firstLine = lines[0]?.trim() || '';
      const hasLang = /^[a-zA-Z0-9_-]+$/.test(firstLine);
      const codeContent = hasLang ? lines.slice(1).join('\n') : lines.join('\n');
      const langAttr = hasLang ? ` data-lang="${escapeHtml(firstLine)}"` : '';
      return `<pre class="code-block"${langAttr}><code>${escapeHtml(codeContent)}</code></pre>`;
    }

    return renderMarkdownProse(segment, turnId, validSourcesMap, seenFirstRef);
  });

  const topStripHtml = renderTopSourcesStrip(turnId, sources);
  return `${topStripHtml}\n<div class="answer-prose-content" id="answer-prose-${turnId}">${htmlSegments.join('\n')}</div>`;
}

function renderMarkdownProse(prose, turnId, validSourcesMap, seenFirstRef) {
  // Limpa rótulo literal "Lead Executivo" / "Síntese Executiva" caso o modelo o repita e garante separação de cabeçalhos e listas
  const normalizedProse = String(prose || '')
    .replace(/\r\n/g, '\n')
    .replace(/^\s*(?:\*\*|#+\s*)?(?:Lead Executivo|S[íi]ntese Executiva|Resumen Ejecutivo|Executive Summary)(?:\*\*)?[:\s—-]*\n+/i, '')
    .replace(/^(#{1,4}\s+[^\n]+)$/gm, '\n\n$1\n\n')
    .replace(/([^\n])\n((?:[-*•]|\d+[.)])\s+)/g, (full, prevChar, listStart, offset, fullStr) => {
      // Se a linha anterior não for item de lista, insere quebra dupla para abrir <ul>/<ol> limpo
      const before = fullStr.slice(0, offset + 1);
      const prevLine = before.split('\n').pop() || '';
      if (/^\s*(?:[-*•]|\d+[.)])\s+/.test(prevLine)) {
        return full;
      }
      return `${prevChar}\n\n${listStart}`;
    });

  const blocks = normalizedProse
    .trim()
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);

  return blocks
    .map((block) => {
      const headingMatch = block.match(/^(#{1,4})\s+([\s\S]*)$/);
      if (headingMatch) {
        const level = Math.min(headingMatch[1].length + 2, 5);
        const cleanHeadingText = headingMatch[2].replace(/^#+\s*/, '').trim();
        return `<h${level} class="answer-heading">${formatInlineMarkdownAndCitations(cleanHeadingText, turnId, validSourcesMap, seenFirstRef)}</h${level}>`;
      }

      const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);

      // Suporte a Tabelas Markdown (| Coluna 1 | Coluna 2 |)
      const isTable =
        lines.length >= 2 &&
        lines.every((l) => l.includes('|')) &&
        lines.some((l) => /^\|?[\s:-]+\|[\s|:-]*$/.test(l));
      if (isTable) {
        const parseRow = (rowStr) =>
          rowStr
            .replace(/^\|/, '')
            .replace(/\|$/, '')
            .split('|')
            .map((cell) => cell.trim());

        const headerCells = parseRow(lines[0]);
        const bodyRows = lines
          .slice(1)
          .filter((l) => !/^\|?[\s:-]+\|[\s|:-]*$/.test(l))
          .map(parseRow);

        const theadHtml = `<thead><tr>${headerCells
          .map((c) => `<th>${formatInlineMarkdownAndCitations(c, turnId, validSourcesMap, seenFirstRef)}</th>`)
          .join('')}</tr></thead>`;
        const tbodyHtml = `<tbody>${bodyRows
          .map(
            (row) =>
              `<tr>${row
                .map((c) => `<td>${formatInlineMarkdownAndCitations(c, turnId, validSourcesMap, seenFirstRef)}</td>`)
                .join('')}</tr>`
          )
          .join('')}</tbody>`;
        return `<div class="answer-table-wrap"><table class="answer-table">${theadHtml}${tbodyHtml}</table></div>`;
      }

      // Suporte a Blockquote (> texto)
      const isBlockquote = lines.length > 0 && lines.every((l) => /^>\s*/.test(l));
      if (isBlockquote) {
        const quoteLines = lines
          .map((l) => l.replace(/^>\s*/, ''))
          .map((l) => formatInlineMarkdownAndCitations(l, turnId, validSourcesMap, seenFirstRef))
          .join('<br>');
        return `<blockquote class="answer-blockquote">${quoteLines}</blockquote>`;
      }

      const isUnorderedList = lines.length > 0 && lines.every((l) => /^[-*•]\s+/.test(l));
      if (isUnorderedList) {
        const items = lines
          .map((l) => l.replace(/^[-*•]\s+/, ''))
          .map((item) => `<li>${formatInlineMarkdownAndCitations(item, turnId, validSourcesMap, seenFirstRef)}</li>`)
          .join('');
        return `<ul class="answer-list">${items}</ul>`;
      }

      const isOrderedList = lines.length > 0 && lines.every((l) => /^\d+[.)]\s+/.test(l));
      if (isOrderedList) {
        const items = lines
          .map((l) => l.replace(/^\d+[.)]\s+/, ''))
          .map((item) => `<li>${formatInlineMarkdownAndCitations(item, turnId, validSourcesMap, seenFirstRef)}</li>`)
          .join('');
        return `<ol class="answer-list answer-list-ordered">${items}</ol>`;
      }

      const joinedLines = lines
        .map((line) => formatInlineMarkdownAndCitations(line, turnId, validSourcesMap, seenFirstRef))
        .join('<br>');
      return `<p class="answer-paragraph">${joinedLines}</p>`;
    })
    .join('\n');
}

function formatInlineMarkdownAndCitations(text, turnId, validSourcesMap, seenFirstRef) {
  let escaped = escapeHtml(text);

  // Inline code `code`
  escaped = escaped.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');

  // Bold **text**
  escaped = escaped.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  // Italic *text*
  escaped = escaped.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>');

  // Citações [1][2] -> Links de rodapé com pílula de domínio confiável estilo Perplexity ([1] domain)
  escaped = escaped.replace(/\[(\d+)\]/g, (full, numStr) => {
    const idx = Number(numStr);
    const src = validSourcesMap.get(idx);
    if (!src) {
      return '';
    }
    const refIdAttr = !seenFirstRef.has(idx)
      ? ` id="cite-ref-${turnId}-${idx}"`
      : '';
    seenFirstRef.add(idx);

    const shortHost = formatShortDomain(src.domain);
    const tooltip = `[${idx}] ${src.title} — ${src.domain}`;
    const hostBadge = shortHost ? `<span class="citation-host">${escapeHtml(shortHost)}</span>` : '';
    return `<sup class="footnote-ref"><a href="#source-${turnId}-${idx}"${refIdAttr} class="citation-link" data-source-id="source-${turnId}-${idx}" title="${escapeHtml(tooltip)}">[${idx}]${hostBadge}</a></sup>`;
  });

  return escaped;
}

/**
 * Gera perguntas de acompanhamento (Follow-up) contextuais no idioma da consulta
 * e ancoradas nos títulos das fontes extraídas (estilo Perplexity "Relacionadas").
 */
function buildContextualFollowUps(question = '', sources = []) {
  const q = String(question || '').trim();
  const lowerQ = q.toLowerCase();
  const isSpanish =
    /\b(septiembre|qué|cómo|cuáles|atentado|español|historia|cuándo|dónde|por qué)\b/i.test(lowerQ) ||
    sources.some((s) => /\b(espanol|elpais|bbc\.com\/mundo|infobae|rtve)\b/i.test(String(s.url || '')));
  const isEnglish =
    !isSpanish &&
    /\b(what|how|why|when|where|architecture|performance|explained|between)\b/i.test(lowerQ);

  const topic = q.length > 58 ? `${q.slice(0, 55).trim()}…` : (q || 'este tema');

  if (isSpanish) {
    return [
      `¿Cuáles fueron las consecuencias políticas y de seguridad a largo plazo de ${topic}?`,
      `¿Cuál es la cronología detallada y los hechos clave verificados sobre ${topic}?`,
      `¿Qué investigaciones oficiales y medidas se tomaron tras ${topic}?`,
      `¿Cómo impactó ${topic} en la geopolítica y la regulación internacional?`
    ];
  }

  if (isEnglish) {
    return [
      `What are the key architectural trade-offs and edge cases of ${topic}?`,
      `How does ${topic} compare in real-world benchmarks and production workloads?`,
      `What are the security implications and failure modes of ${topic}?`,
      `Can you show a step-by-step technical breakdown of ${topic}?`
    ];
  }

  return [
    `Quais são os detalhes técnicos mais críticos e a cronologia completa sobre ${topic}?`,
    `Quais foram as consequências práticas e o impacto de longo prazo de ${topic}?`,
    `Como as diferentes fontes extraídas comparam as causas e desdobramentos de ${topic}?`,
    `Quais pontos de atenção, falhas ou vulnerabilidades existem em torno de ${topic}?`
  ];
}

/**
 * Renderiza a barra de ações da resposta, sugestões de acompanhamento (Follow-up)
 * e a lista completa de fontes abaixo de cada resposta no estilo Google SERP Hacker.
 */
function renderTurnSourcesFootnotes(turnId, sources = [], meta = {}) {
  if (!sources || sources.length === 0) {
    if (meta.status === 'pending' || meta.status === 'searching' || meta.status === 'extracting') {
      return `
        <div class="sources-loading-skeleton" aria-live="polite">
          <span class="skeleton-dot"></span>
          <span><code>[READABILITY::DOM]</code> Extraindo payload textual dos 6 alvos via <code>undici</code>…</span>
        </div>
      `;
    }
    return `
      <footer class="turn-footnotes turn-footnotes-empty" aria-label="Fontes da resposta">
        <div class="footnotes-empty-notice">
          Nenhuma fonte web pôde ser extraída com sucesso para esta resposta (alvos inacessíveis foram descartados).
        </div>
      </footer>
    `;
  }

  const followUps = meta.status === 'completed' ? buildContextualFollowUps(meta.question || '', sources) : [];
  const followUpsHtml =
    followUps.length > 0
      ? `
        <section class="turn-followups" aria-label="Perguntas de acompanhamento sugeridas">
          <div class="followups-header">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <polyline points="9 18 15 12 9 6"></polyline>
            </svg>
            <h4 class="followups-title">Explorar Acompanhamento (Follow-up Contextual)</h4>
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

  const actionToolbarHtml = `
    <div class="turn-action-bar" aria-label="Ações da resposta">
      <button type="button" class="turn-action-btn" data-copy-turn="${turnId}" title="Copiar resposta para a área de transferência">
        <span class="copy-btn-label">Copiar</span>
      </button>

      <a
        href="/turns/${turnId}/export.md"
        download="deepevil-turn-${turnId}.md"
        class="turn-action-btn"
        data-export-turn="${turnId}"
        title="Baixar dossiê completo em Markdown (.md) com citações e notas de rodapé verificadas"
      >
        <span>Exportar .md</span>
      </a>

      <div class="turn-translate-group" role="group" aria-label="Traduzir resposta">
        <label for="translate-lang-${turnId}" class="sr-only">Idioma para tradução</label>
        <select id="translate-lang-${turnId}" class="turn-translate-select" title="Selecionar idioma de destino">
          <option value="pt-BR">Português (BR)</option>
          <option value="en">English</option>
          <option value="es">Español</option>
          <option value="fr">Français</option>
          <option value="de">Deutsch</option>
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

      <a href="#source-${turnId}-1" class="turn-action-btn" title="Rolar para as notas de rodapé verificadas">
        <span class="g-blue">●</span>
        <span>${sources.length} ${sources.length === 1 ? 'fonte verificada' : 'fontes verificadas'}</span>
      </a>
    </div>
  `;

  const itemsHtml = sources
    .map((src, i) => {
      const idx = src.citationIndex ?? src.citation_index ?? i + 1;
      const wordCount = Number(src.wordCount ?? src.word_count ?? 0);
      const sourceAnchorId = `source-${turnId}-${idx}`;
      const backRefHref = `#cite-ref-${turnId}-${idx}`;
      const previewExcerpt = String(src.excerpt || '').slice(0, 420);
      const hasMore = String(src.excerpt || '').length > 420;
      const colorCycle = ['g-border-blue', 'g-border-red', 'g-border-yellow', 'g-border-green'][(idx - 1) % 4];

      return `
        <li id="${sourceAnchorId}" class="footnote-item ${colorCycle}" tabindex="-1">
          <div class="footnote-item-header">
            <a href="${backRefHref}" class="footnote-badge" title="Voltar para a citação [${idx}] no texto">[${idx}]</a>
            <div class="footnote-title-group">
              <div class="serp-cite-line">
                <span class="serp-domain-host">${escapeHtml(src.domain)}</span>
                <span class="meta-sep" aria-hidden="true">›</span>
                <span class="serp-url-path">${escapeHtml(src.url)}</span>
              </div>
              <a href="${escapeHtml(src.url)}" target="_blank" rel="noopener noreferrer" class="footnote-link">
                ${escapeHtml(src.title)}
              </a>
              <div class="footnote-meta">
                <span class="footnote-stats tabular-nums">${wordCount} palavras extraídas</span>
                <span class="meta-sep" aria-hidden="true">·</span>
                <a href="${backRefHref}" class="footnote-backlink" title="Ir para citação no texto">↩ saltar para citação [${idx}]</a>
              </div>
            </div>
          </div>
          <details class="footnote-excerpt-details">
            <summary class="footnote-excerpt-summary">inspecionar_payload_readability() // trecho bruto [${idx}]</summary>
            <blockquote class="footnote-excerpt-text" cite="${escapeHtml(src.url)}">
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
            <polyline points="4 17 10 11 4 5"></polyline>
            <line x1="12" y1="19" x2="20" y2="19"></line>
          </svg>
          <h4 class="footnotes-title">SERP // Notas de Rodapé &amp; Fontes Extraídas</h4>
        </div>
        <span class="footnotes-count tabular-nums">[${sources.length} ${sources.length === 1 ? 'ALVO VERIFICADO' : 'ALVOS VERIFICADOS'}]</span>
      </div>
      <ol class="footnotes-list">
        ${itemsHtml}
      </ol>
    </footer>
  `;
}

/**
 * Renderiza o indicador de status do pipeline no estilo Google Hacker Terminal.
 */
function renderPipelineStatusBadge(status, details = {}) {
  const labelMap = {
    pending: '[SYS::INIT] Inicializando socket de busca DeepEvil…',
    searching: `[SYS::DORK_SEARCH] Consultando índice web (${escapeHtml(details.searchQuery || 'top 6 alvos')})…`,
    extracting: `[SYS::READABILITY] Extraindo DOM legível via undici + jsdom (${Number(details.attemptedCount || 6)} URLs)…`,
    streaming: `[SYS::LLM_STREAM] Decodificando resposta via ${escapeHtml(details.provider || 'LLM')} (${Number(details.extractedCount || 0)} fontes verificadas)…`,
    completed: `[200::OK] ${Number(details.extractedCount || 0)}/${Number(details.attemptedCount || 0)} páginas extraídas${details.model ? ` · engine=${escapeHtml(details.model)}` : ''}${details.durationMs ? ` · time=${(Number(details.durationMs) / 1000).toFixed(2)}s` : ''}`,
    error: `[ERR::500] ${escapeHtml(details.errorMessage || 'Falha no processamento')}`
  };

  const stateClass =
    status === 'completed'
      ? 'status-completed'
      : status === 'error'
      ? 'status-error'
      : 'status-active';

  const text = labelMap[status] || labelMap.pending;

  return `
    <div class="pipeline-status ${stateClass}" data-status="${escapeHtml(status)}">
      <span class="status-indicator" aria-hidden="true"></span>
      <span class="status-text tabular-nums">${text}</span>
    </div>
  `;
}

/**
 * Renderiza um turno completo (Pergunta + AI Overview DeepEvil + Lista SERP de fontes).
 */
function renderTurnCard(turn, options = {}) {
  const isLive = Boolean(options.isLive || turn.status === 'pending');
  const sources = Array.isArray(turn.sources) ? turn.sources : [];

  const statusHtml = renderPipelineStatusBadge(turn.status, {
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
      ? `<div class="turn-error-box" role="alert"><strong>[KERNEL_PANIC] Falha na síntese:</strong> ${escapeHtml(turn.error_message)}</div>`
      : renderAnswerMarkdownWithFootnotes(turn.answer_markdown, turn.id, sources);

  const sourcesHtml = renderTurnSourcesFootnotes(turn.id, sources, {
    status: turn.status,
    question: turn.question
  });

  const innerContent = isLive
    ? `
        <div
          id="sse-container-${turn.id}"
          class="turn-stream-wrapper"
          hx-ext="sse"
          sse-connect="/stream/${turn.id}"
          sse-close="done"
          data-stream-turn="${turn.id}"
        >
          <div id="turn-status-${turn.id}" sse-swap="status" class="turn-status-slot">
            ${statusHtml}
          </div>

          <section id="turn-answer-${turn.id}" sse-swap="answer" class="turn-answer-body" aria-live="polite">
            ${answerHtml}
          </section>

          <div id="turn-sources-${turn.id}" sse-swap="sources" class="turn-sources-slot">
            ${sourcesHtml}
          </div>
        </div>
      `
    : `
        <div id="turn-status-${turn.id}" class="turn-status-slot">
          ${statusHtml}
        </div>

        <section id="turn-answer-${turn.id}" class="turn-answer-body">
          ${answerHtml}
        </section>

        <div id="turn-sources-${turn.id}" sse-swap="sources" class="turn-sources-slot">
          ${sourcesHtml}
        </div>
      `;

  return `
    <article id="turn-${turn.id}" class="turn-card${isLive ? ' turn-card-live' : ''}" data-turn-id="${turn.id}">
      <div class="google-four-color-bar" aria-hidden="true"></div>
      <header class="turn-question-header">
        <div class="turn-question-meta">
          <span class="turn-badge">root@deepevil:~# query</span>
          ${turn.search_query && turn.search_query !== turn.question ? `<span class="turn-search-query" title="Dork contextual enviada ao motor de busca">dork="${escapeHtml(turn.search_query)}"</span>` : ''}
        </div>
        <h2 class="turn-question-title">${escapeHtml(turn.question)}</h2>
      </header>
      ${innerContent}
    </article>
  `;
}

/**
 * Renderiza a lista de conversas na barra lateral, identificadas pela primeira pergunta feita.
 */
function renderSidebarConversations(conversations = [], activeConversationId = null, isOob = false) {
  const oobAttr = isOob ? ' hx-swap-oob="true"' : '';

  if (!conversations || conversations.length === 0) {
    return `
      <nav id="sidebar-conversations" class="sidebar-nav"${oobAttr} aria-label="Conversas anteriores">
        <div class="sidebar-empty">
          <code>[0x00]</code> Nenhuma pesquisa registrada. Dispare uma busca no terminal ao lado.
        </div>
      </nav>
    `;
  }

  const items = conversations
    .map((conv) => {
      const isActive = Number(conv.id) === Number(activeConversationId);
      const activeClass = isActive ? ' sidebar-item-active' : '';
      const ariaCurrent = isActive ? ' aria-current="page"' : '';
      const turnCount = Number(conv.turn_count || 1);

      return `
        <div class="sidebar-item-row${activeClass}">
          <a
            href="/c/${conv.id}"
            hx-get="/conversations/${conv.id}"
            hx-target="#main-stage"
            hx-push-url="/c/${conv.id}"
            class="sidebar-item-link"${ariaCurrent}
            title="${escapeHtml(conv.title)}"
          >
            <span class="sidebar-item-title">${escapeHtml(conv.title)}</span>
            <span class="sidebar-item-meta tabular-nums">#${conv.id} · ${turnCount} ${turnCount === 1 ? 'execução' : 'execuções'}</span>
          </a>
          <button
            type="button"
            class="sidebar-delete-btn"
            hx-delete="/conversations/${conv.id}"
            hx-target="#sidebar-conversations"
            hx-swap="outerHTML"
            aria-label="Excluir conversa: ${escapeHtml(conv.title)}"
            title="Excluir conversa"
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
    </nav>
  `;
}

/**
 * Renderiza a barra de busca estilo Google Pill Search Bar com seletor de LLM (Ollama)
 * e botões clássicos do Google ("Pesquisa DeepEvil" e "Estou com Sorte").
 */
function renderComposerForm(activeConversation = null, isOob = false, options = {}) {
  const oobAttr = isOob ? ' hx-swap-oob="true"' : '';
  const convId = activeConversation?.id ? String(activeConversation.id) : '';
  const isFollowUp = Boolean(convId);

  const rawModels = Array.isArray(options.models) && options.models.length > 0
    ? options.models
    : [
        { name: options.activeModel || 'granite4.2:latest', parameterSize: 'Local' }
      ];

  const selectedModelName = options.activeModel || rawModels[0]?.name || 'granite4.2:latest';

  const modelOptionsHtml = rawModels
    .map((m) => {
      const modelName = typeof m === 'string' ? m : m.name;
      const rawBadge = typeof m === 'object' ? (m.parameterSize || (m.sizeGb ? (m.sizeGb === 'Cloud' ? 'Cloud' : `${m.sizeGb}GB`) : '')) : '';
      const paramSize = rawBadge ? ` (${rawBadge})` : '';
      const isSelected = modelName === selectedModelName ? ' selected' : '';
      return `<option value="${escapeHtml(modelName)}"${isSelected}>${escapeHtml(modelName)}${escapeHtml(paramSize)}</option>`;
    })
    .join('');

  const placeholder = isFollowUp
    ? 'Faça uma pergunta de acompanhamento (mantém o contexto)…'
    : 'Pesquise no DeepEvil ou digite uma pergunta…';

  const contextBanner = isFollowUp
    ? `
      <div class="composer-context-bar">
        <span class="context-pill">
          <span class="g-dot-green" aria-hidden="true"></span>
          <span>Contexto ativo · <strong>${escapeHtml(activeConversation.title)}</strong></span>
        </span>
        <a
          href="/"
          hx-get="/new"
          hx-target="#main-stage"
          hx-push-url="/"
          class="context-reset-link"
        >[ + Nova Pesquisa ]</a>
      </div>
    `
    : '';

  return `
    <div id="composer-region" class="composer-region"${oobAttr}>
      ${contextBanner}
      <form
        id="ask-form"
        class="composer-form google-search-capsule"
        action="/ask"
        method="POST"
        hx-post="/ask"
        hx-target="#conversation-turns"
        hx-swap="beforeend"
      >
        <input type="hidden" name="conversationId" id="active-conversation-id" value="${escapeHtml(convId)}">
        <div class="google-pill-bar">
          <!-- Ícone de Lupa Clássico do Google -->
          <span class="google-search-icon" aria-hidden="true">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
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

          <!-- Seletor Dinâmico de LLM (Ollama / Local) -->
          <div class="model-selector-wrap" title="Selecionar modelo LLM do Ollama para esta pesquisa">
            <label for="model-select" class="sr-only">Modelo LLM</label>
            <select id="model-select" name="model" class="google-model-select" data-active-model="${escapeHtml(selectedModelName)}">
              ${modelOptionsHtml}
            </select>
          </div>

          <button type="submit" id="ask-submit-btn" class="composer-submit-btn" title="Executar pesquisa DeepEvil">
            <span>${isFollowUp ? 'Follow-up' : 'Pesquisar'}</span>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <line x1="5" y1="12" x2="19" y2="12"></line>
              <polyline points="12 5 19 12 12 19"></polyline>
            </svg>
          </button>
        </div>

        <div class="google-classic-buttons">
          <button type="submit" class="g-btn">Pesquisa DeepEvil</button>
          <button
            type="button"
            id="feeling-lucky-btn"
            class="g-btn g-btn-lucky"
            data-lucky-queries="Como funcionam rootkits de kernel Linux via ftrace e como detectá-los?|Quais técnicas o Mozilla Readability usa para limpar o DOM de páginas web?|Como funcionam Server-Sent Events (SSE) sobre HTTP e por que são ideais para streaming?|Arquitetura interna do motor V8 no Node.js e gerenciamento de memória do undici"
          >
            Estou com sorte
          </button>
          <span class="composer-hint">
            <kbd>Enter</kbd> pesquisa · <kbd>Shift+Enter</kbd> nova linha
          </span>
        </div>
      </form>
    </div>
  `;
}

/**
 * Renderiza o palco principal (#main-stage) com o visual limpo do Google (DeepEvil).
 */
function renderMainStage(activeConversation = null, envStatus = {}) {
  const turns = Array.isArray(activeConversation?.turns) ? activeConversation.turns : [];
  const hasTurns = turns.length > 0;

  const emptyHero = !hasTurns
    ? `
      <div id="empty-hero" class="empty-hero google-hacker-hero">
        <h1 class="google-hero-logo">
          ${renderDeepEvilLogo('logo-xl')}
        </h1>

        <div class="hero-suggestions" aria-label="Sugestões rápidas de pesquisa">
          <button type="button" class="suggestion-chip" data-suggest="Como funcionam rootkits de kernel Linux via ftrace e como detectá-los?">
            <span class="g-blue">●</span> Linux Kernel ftrace &amp; syscall hooks
          </button>
          <button type="button" class="suggestion-chip" data-suggest="Quais as diferenças práticas entre Server-Sent Events (SSE) e WebSockets para streaming de baixa latência?">
            <span class="g-red">●</span> SSE vs WebSockets low-latency streaming
          </button>
          <button type="button" class="suggestion-chip" data-suggest="Como o Mozilla Readability identifica o conteúdo principal de um artigo HTML?">
            <span class="g-green">●</span> Mozilla Readability DOM algorithm
          </button>
        </div>
      </div>
    `
    : '';

  const turnsHtml = turns.map((turn) => renderTurnCard(turn, { isLive: turn.status === 'pending' })).join('\n');

  const topSerpBar = `
    <header class="google-top-serp-bar" aria-label="Barra de status DeepEvil">
      <div class="serp-bar-left">
        <a href="/" hx-get="/new" hx-target="#main-stage" hx-push-url="/" class="serp-mini-logo">
          ${renderDeepEvilLogo('logo-sm')}
        </a>
        <div class="serp-tabs" role="navigation" aria-label="Modos do motor">
          <span class="serp-tab serp-tab-active">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
            Tudo
          </span>
          <span class="serp-tab" id="top-bar-llm-badge">
            <span class="g-blue">●</span> Ollama (${escapeHtml(envStatus.model || 'granite4.2:latest')})
          </span>
        </div>
      </div>
      <div class="serp-bar-right tabular-nums">
        <span class="env-pill pill-ok">127.0.0.1:3000</span>
      </div>
    </header>
  `;

  return `
    ${topSerpBar}
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
  `;
}

/**
 * Renderiza o documento HTML completo da aplicação DeepEvil.
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
  <link rel="icon" type="image/svg+xml" href="/favicon.svg?v=deepevil-d-2">
  <link rel="shortcut icon" href="/favicon.ico?v=deepevil-d-2">
  <link rel="stylesheet" href="/styles.css">
  <script src="/vendor/htmx.min.js" defer></script>
  <script src="/vendor/sse.js" defer></script>
  <script src="/app.js" defer></script>
</head>
<body>
  <div class="app-shell">
    <!-- Barra Lateral: Histórico de Conversas -->
    <aside class="app-sidebar" aria-label="Histórico de conversas">
      <div class="google-four-color-bar" aria-hidden="true"></div>
      <div class="sidebar-header">
        <a
          href="/"
          hx-get="/new"
          hx-target="#main-stage"
          hx-push-url="/"
          class="brand-logo"
        >
          <span class="brand-mark" aria-hidden="true">
            ${renderDeepEvilDIcon(22, 'sidebar-d-clip')}
          </span>
          <span class="brand-text">
            ${renderDeepEvilLogo('logo-sidebar')}
          </span>
        </a>

        <a
          href="/"
          hx-get="/new"
          hx-target="#main-stage"
          hx-push-url="/"
          class="new-thread-btn"
          title="Iniciar uma nova pesquisa no DeepEvil"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <line x1="12" y1="5" x2="12" y2="19"></line>
            <line x1="5" y1="12" x2="19" y2="12"></line>
          </svg>
          <span>+ Nova Pesquisa</span>
        </a>
      </div>

      <div class="sidebar-section-label">
        <span>Histórico</span>
      </div>

      ${renderSidebarConversations(conversations, activeConversation?.id, false)}

      <div class="sidebar-footer">
        <div class="privacy-badge">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
            <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
          </svg>
          <span><code>127.0.0.1:3000</code></span>
        </div>
      </div>
    </aside>

    <!-- Palco Principal DeepEvil -->
    <main id="main-stage" class="app-main">
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
  renderAnswerMarkdownWithFootnotes,
  renderTurnSourcesFootnotes,
  renderPipelineStatusBadge,
  renderTurnCard,
  renderSidebarConversations,
  renderComposerForm,
  renderMainStage,
  renderFullPage
};
