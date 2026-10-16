'use strict';

(function () {
  // 1. Suporte de fallback caso field-sizing: content não esteja disponível
  function bindTextareaAutoGrow(root) {
    if (typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('field-sizing', 'content')) {
      return;
    }
    const wrappers = (root || document).querySelectorAll('.growable-textarea > textarea');
    wrappers.forEach((textarea) => {
      if (textarea.dataset.growBound) return;
      textarea.dataset.growBound = '1';
      textarea.addEventListener('input', () => {
        if (textarea.parentNode) {
          textarea.parentNode.dataset.replicatedValue = textarea.value;
        }
      });
    });
  }

  // 2. Atalho Enter para submeter o formulário via htmx (Shift+Enter para nova linha)
  document.addEventListener('keydown', (event) => {
    const target = event.target;
    if (!target || target.id !== 'question-input') return;

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      const form = target.closest('form');
      if (form && target.value.trim().length > 0) {
        if (typeof form.requestSubmit === 'function') {
          form.requestSubmit();
        } else if (window.htmx) {
          window.htmx.trigger(form, 'submit');
        }
      }
    }
  });

  // 3. Chips de sugestão de pesquisa, botão "Estou com Sorte // Root Dork" e destaque de citações
  document.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-suggest]');
    if (chip) {
      const suggestion = chip.getAttribute('data-suggest');
      const textarea = document.getElementById('question-input');
      const form = document.getElementById('ask-form');
      if (textarea && form && suggestion) {
        textarea.value = suggestion;
        textarea.focus();
        if (typeof form.requestSubmit === 'function') {
          form.requestSubmit();
        } else if (window.htmx) {
          window.htmx.trigger(form, 'submit');
        }
      }
      return;
    }

    const luckyBtn = event.target.closest('#feeling-lucky-btn');
    if (luckyBtn) {
      const rawList = luckyBtn.getAttribute('data-lucky-queries') || '';
      const options = rawList.split('|').map((s) => s.trim()).filter(Boolean);
      const textarea = document.getElementById('question-input');
      const form = document.getElementById('ask-form');
      if (textarea && form && options.length > 0) {
        const chosen = textarea.value.trim() || options[Math.floor(Math.random() * options.length)];
        textarea.value = chosen;
        textarea.focus();
        if (typeof form.requestSubmit === 'function') {
          form.requestSubmit();
        } else if (window.htmx) {
          window.htmx.trigger(form, 'submit');
        }
      }
      return;
    }

    // 4. Botão "Copiar" resposta
    const copyBtn = event.target.closest('[data-copy-turn]');
    if (copyBtn) {
      const turnId = copyBtn.getAttribute('data-copy-turn');
      const proseEl = document.getElementById(`answer-prose-${turnId}`) || document.getElementById(`turn-answer-${turnId}`);
      if (proseEl && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        const textToCopy = (proseEl.innerText || proseEl.textContent || '').trim();
        navigator.clipboard.writeText(textToCopy).then(() => {
          const labelEl = copyBtn.querySelector('.copy-btn-label');
          if (labelEl) {
            const orig = labelEl.textContent;
            labelEl.textContent = 'Copiado ✓';
            setTimeout(() => {
              labelEl.textContent = orig;
            }, 1800);
          }
        }).catch(() => {});
      }
      return;
    }

    // 5. Botão "Traduzir com IA" (Streaming SSE em tempo real + Cache SQLite 0ms)
    const translateBtn = event.target.closest('[data-translate-turn]');
    if (translateBtn) {
      const turnId = translateBtn.getAttribute('data-translate-turn');
      const answerEl = document.getElementById(`turn-answer-${turnId}`);
      const langSelect = document.getElementById(`translate-lang-${turnId}`);
      const restoreBtn = document.getElementById(`restore-btn-${turnId}`);
      const modelSelect = document.getElementById('model-select');
      if (!turnId || !answerEl || translateBtn.disabled) return;

      if (!window.__deepevilOriginalAnswers) {
        window.__deepevilOriginalAnswers = new Map();
      }
      if (!window.__deepevilOriginalAnswers.has(turnId)) {
        window.__deepevilOriginalAnswers.set(turnId, answerEl.innerHTML);
      }

      const targetLang = langSelect ? langSelect.value : 'pt-BR';
      const selectedModel = modelSelect ? modelSelect.value : '';
      const labelEl = translateBtn.querySelector('.translate-btn-label');

      translateBtn.disabled = true;
      translateBtn.classList.add('is-translating');
      if (labelEl) labelEl.textContent = 'Traduzindo…';

      const finishTranslation = (ok, meta) => {
        translateBtn.disabled = false;
        translateBtn.classList.remove('is-translating');
        if (ok) {
          if (restoreBtn) restoreBtn.hidden = false;
          if (labelEl) {
            if (meta && meta.cached) {
              labelEl.textContent = `Traduzido (${targetLang}) · cache 0ms`;
            } else if (meta && typeof meta.durationMs === 'number') {
              labelEl.textContent = `Traduzido (${targetLang}) · ${(meta.durationMs / 1000).toFixed(1)}s`;
            } else {
              labelEl.textContent = `Traduzido (${targetLang})`;
            }
          }
        } else if (labelEl) {
          labelEl.textContent = 'Erro ao traduzir';
        }
      };

      if (typeof window.EventSource === 'function') {
        const streamUrl = `/turns/${encodeURIComponent(turnId)}/translate/stream?lang=${encodeURIComponent(targetLang)}&model=${encodeURIComponent(selectedModel)}`;
        const es = new window.EventSource(streamUrl);
        let receivedAny = false;

        es.addEventListener('answer', (e) => {
          if (e.data) {
            receivedAny = true;
            answerEl.innerHTML = e.data;
          }
        });

        es.addEventListener('done', (e) => {
          es.close();
          let meta = {};
          try {
            meta = JSON.parse(e.data || '{}');
          } catch (_) {
            // Ignora erro de parse
          }
          finishTranslation(receivedAny, meta);
        });

        es.addEventListener('error', () => {
          es.close();
          if (receivedAny) {
            finishTranslation(true, {});
          } else {
            finishTranslation(false, {});
          }
        });
        return;
      }

      fetch(`/turns/${encodeURIComponent(turnId)}/translate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ targetLang, model: selectedModel })
      })
        .then((res) => res.json())
        .then((data) => {
          if (data && data.ok && data.html) {
            answerEl.innerHTML = data.html;
            finishTranslation(true, data);
          } else {
            finishTranslation(false, {});
          }
        })
        .catch(() => {
          finishTranslation(false, {});
        });
      return;
    }

    // 6. Botão "↺ Original" (Restaurar idioma original)
    const restoreBtn = event.target.closest('[data-restore-turn]');
    if (restoreBtn) {
      const turnId = restoreBtn.getAttribute('data-restore-turn');
      const answerEl = document.getElementById(`turn-answer-${turnId}`);
      const translateBtn = document.querySelector(`[data-translate-turn="${turnId}"]`);
      if (turnId && answerEl && window.__deepevilOriginalAnswers && window.__deepevilOriginalAnswers.has(turnId)) {
        answerEl.innerHTML = window.__deepevilOriginalAnswers.get(turnId);
        restoreBtn.hidden = true;
        if (translateBtn) {
          const labelEl = translateBtn.querySelector('.translate-btn-label');
          if (labelEl) labelEl.textContent = 'Traduzir';
        }
      }
      return;
    }

    // 7. Destaque visual suave ao clicar numa citação [1] de rodapé ou num card da faixa superior de fontes
    const citationLink = event.target.closest('.citation-link, .top-source-card');
    if (citationLink) {
      const sourceId = citationLink.getAttribute('data-source-id');
      if (sourceId) {
        const targetEl = document.getElementById(sourceId);
        if (targetEl) {
          document.querySelectorAll('.footnote-highlighted').forEach((el) => {
            el.classList.remove('footnote-highlighted');
          });
          targetEl.classList.add('footnote-highlighted');
          const details = targetEl.querySelector('details');
          if (details) {
            details.open = true;
          }
        }
      }
    }
  });

  // 5. Garante que qualquer container de streaming recém-injetado conecte via SSE
  const activeStreams = new Set();

  function ensureLiveStreamsConnected(root) {
    const containers = (root || document).querySelectorAll('[data-stream-turn]');
    containers.forEach((container) => {
      const turnId = container.getAttribute('data-stream-turn');
      if (!turnId || activeStreams.has(turnId)) return;

      activeStreams.add(turnId);

      const statusSlot = document.getElementById(`turn-status-${turnId}`);
      const answerSlot = document.getElementById(`turn-answer-${turnId}`);
      const sourcesSlot = document.getElementById(`turn-sources-${turnId}`);

      const es = new EventSource(`/stream/${encodeURIComponent(turnId)}`);

      es.addEventListener('status', (e) => {
        if (statusSlot && e.data) statusSlot.innerHTML = e.data;
      });

      es.addEventListener('sources', (e) => {
        if (sourcesSlot && e.data) sourcesSlot.innerHTML = e.data;
      });

      es.addEventListener('answer', (e) => {
        if (answerSlot && e.data) answerSlot.innerHTML = e.data;
      });

      es.addEventListener('done', () => {
        es.close();
      });

      es.onerror = () => {
        es.close();
      };
    });
  }

  // 6. Sincronização do seletor de LLM (Ollama) e atualização do badge superior
  function syncModelSelector(root) {
    const selectEl = (root || document).querySelector('#model-select');
    if (!selectEl) return;

    const savedModel = window.localStorage ? window.localStorage.getItem('deepevil_selected_model') : '';
    if (savedModel) {
      const hasOption = Array.from(selectEl.options).some((opt) => opt.value === savedModel);
      if (hasOption) {
        selectEl.value = savedModel;
      }
    }

    const updateTopBadge = (modelName) => {
      const topBadge = document.getElementById('top-bar-llm-badge');
      if (topBadge && modelName) {
        topBadge.innerHTML = `<span class="g-blue">●</span> Ollama (${modelName})`;
      }
    };

    updateTopBadge(selectEl.value);

    if (!selectEl.dataset.modelBound) {
      selectEl.dataset.modelBound = '1';
      selectEl.addEventListener('change', () => {
        if (window.localStorage) {
          window.localStorage.setItem('deepevil_selected_model', selectEl.value);
        }
        updateTopBadge(selectEl.value);
      });
    }
  }

  async function refreshOllamaModelsDropdown() {
    try {
      const res = await fetch('/api/models', { headers: { Accept: 'application/json' } });
      if (!res.ok) return;
      const data = await res.json();
      if (!data || !Array.isArray(data.models) || data.models.length === 0) return;

      const selectEl = document.getElementById('model-select');
      if (!selectEl) return;

      const savedModel = (window.localStorage && window.localStorage.getItem('deepevil_selected_model')) || selectEl.value || data.defaultModel;

      selectEl.innerHTML = data.models
        .map((m) => {
          const name = typeof m === 'string' ? m : m.name;
          const rawBadge = typeof m === 'object' ? (m.parameterSize || (m.sizeGb ? (m.sizeGb === 'Cloud' ? 'Cloud' : `${m.sizeGb}GB`) : '')) : '';
          const size = rawBadge ? ` (${rawBadge})` : '';
          const selected = name === savedModel ? ' selected' : '';
          return `<option value="${name}"${selected}>${name}${size}</option>`;
        })
        .join('');

      syncModelSelector(document);
    } catch (_) {
      // Ignora silenciosamente se offline
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    bindTextareaAutoGrow(document);
    syncModelSelector(document);
    refreshOllamaModelsDropdown();
    ensureLiveStreamsConnected(document);
  });

  document.body.addEventListener('htmx:afterSwap', (event) => {
    bindTextareaAutoGrow(event.target);
    syncModelSelector(document);
    ensureLiveStreamsConnected(document);
  });

  document.body.addEventListener('htmx:oobAfterSwap', () => {
    bindTextareaAutoGrow(document);
    syncModelSelector(document);
  });
})();
