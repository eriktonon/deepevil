'use strict';

(function () {
  const MAX_ORIGINAL_ANSWER_CACHE = 20;

  const STORAGE_KEYS = {
    model: 'deepevil_selected_model',
    focus: 'deepevil_selected_focus',
    scope: 'deepevil_selected_scope',
    lang: 'deepevil_selected_lang',
    sidebarCollapsed: 'deepevil_sidebar_collapsed'
  };

  // Estado global controlado de streams SSE únicos (1 EventSource por turnId)
  const activeStreams = new Map();
  let streamGenerationCounter = 0;

  // Estado do Popover Flutuante de Citação (WCAG 1.4.13)
  let activeCitationRef = null;
  let activeCitationPopover = null;
  let citationCloseTimer = null;

  // Estado do Combobox de Modelos
  let modelCatalog = [];
  let comboboxFiltered = [];
  let comboboxActiveIndex = -1;
  let comboboxOpen = false;

  // Estado do Mobile Drawer
  let drawerPreviouslyFocused = null;

  function safeStorageGet(key) {
    try {
      return window.localStorage ? window.localStorage.getItem(key) : null;
    } catch (_) {
      return null;
    }
  }

  function safeStorageSet(key, value) {
    try {
      if (window.localStorage) {
        window.localStorage.setItem(key, value);
      }
    } catch (_) {
      // Ignora erro de quota ou modo privado
    }
  }

  function prefersReducedMotion() {
    return (
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    );
  }

  function isMobileViewport() {
    return typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 860px)').matches;
  }

  function isEditableTarget(el) {
    if (!el) return false;
    const tag = String(el.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || Boolean(el.isContentEditable);
  }

  // =========================================================================
  // 1. LRU Cache para respostas originais antes da tradução (máx. 20 turnos)
  // =========================================================================
  function getOriginalAnswerCache() {
    if (!(window.__deepevilOriginalAnswers instanceof Map)) {
      window.__deepevilOriginalAnswers = new Map();
    }
    return window.__deepevilOriginalAnswers;
  }

  function setOriginalAnswerCache(turnId, html) {
    const key = String(turnId);
    const cache = getOriginalAnswerCache();
    if (cache.has(key)) {
      cache.delete(key);
    }
    cache.set(key, html);
    while (cache.size > MAX_ORIGINAL_ANSWER_CACHE) {
      const oldestKey = cache.keys().next().value;
      cache.delete(oldestKey);
    }
  }

  // =========================================================================
  // 2. Fallback de auto-grow para textarea quando field-sizing não existe
  // =========================================================================
  function syncTextareaGrowMirror(textarea) {
    if (textarea && textarea.parentNode && textarea.parentNode.classList.contains('growable-textarea')) {
      textarea.parentNode.dataset.replicatedValue = textarea.value;
    }
  }

  function bindTextareaAutoGrow(root) {
    if (typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('field-sizing', 'content')) {
      return;
    }
    const textareas = (root || document).querySelectorAll('.growable-textarea > textarea');
    textareas.forEach((textarea) => {
      if (textarea.dataset.growBound) return;
      textarea.dataset.growBound = '1';
      textarea.addEventListener('input', () => syncTextareaGrowMirror(textarea));
    });
  }

  // =========================================================================
  // 3. Smart Stick-to-Bottom Scroll + Reduced Motion
  // =========================================================================
  function isUserNearBottom(thresholdPx = 120) {
    const docEl = document.documentElement;
    const scrollBottom = window.scrollY + window.innerHeight;
    return docEl.scrollHeight - scrollBottom <= thresholdPx;
  }

  function smartScrollToBottom() {
    if (!isUserNearBottom(120)) return;
    window.scrollTo({
      top: document.documentElement.scrollHeight,
      behavior: prefersReducedMotion() ? 'auto' : 'smooth'
    });
  }

  function scrollTurnToTop(turnId) {
    const turnCard = document.getElementById(`turn-${turnId}`);
    if (!turnCard) return;
    const rect = turnCard.getBoundingClientRect();
    const targetY = Math.max(0, window.scrollY + rect.top - 64);
    window.scrollTo({
      top: targetY,
      behavior: prefersReducedMotion() ? 'auto' : 'smooth'
    });
  }

  // =========================================================================
  // 4. Controlador SSE Único (1 EventSource por turnId, timer vivo, reconnect)
  // =========================================================================
  function updateLiveTimerDom(turnId, startedAt) {
    const statusSlot = document.getElementById(`turn-status-${turnId}`);
    if (!statusSlot) return;
    const timerEl = statusSlot.querySelector('[data-live-timer]');
    if (!timerEl) return;
    const elapsedSec = Math.max(0, (Date.now() - startedAt) / 1000).toFixed(1);
    timerEl.textContent = `${elapsedSec}s`;
  }

  function closeTurnStream(turnId) {
    const key = String(turnId || '');
    const entry = activeStreams.get(key);
    if (!entry) return;
    if (entry.timerInterval) {
      clearInterval(entry.timerInterval);
    }
    try {
      entry.es.close();
    } catch (_) {
      // Ignora erro ao encerrar EventSource
    }
    activeStreams.delete(key);
  }

  function pruneOrphanStreams() {
    for (const key of Array.from(activeStreams.keys())) {
      if (!document.getElementById(`turn-${key}`)) {
        closeTurnStream(key);
      }
    }
  }

  function resetRewriteButton(turnId) {
    const btn = document.querySelector(`[data-rewrite-turn="${CSS.escape(String(turnId))}"]`);
    if (!btn) return;
    btn.disabled = false;
    const orig = btn.getAttribute('data-orig-label') || '↻ Regerar';
    const labelEl = btn.querySelector('.rewrite-btn-label');
    if (labelEl) {
      labelEl.textContent = orig;
    } else {
      btn.textContent = orig;
    }
  }

  function renderReconnectBanner(turnId, statusSlot) {
    if (!statusSlot) return;
    const wrapper = document.createElement('div');
    wrapper.className = 'pipeline-status status-error';
    wrapper.setAttribute('data-status', 'error');

    const mainRow = document.createElement('div');
    mainRow.className = 'pipeline-status-main';

    const dot = document.createElement('span');
    dot.className = 'status-indicator';
    dot.setAttribute('aria-hidden', 'true');

    const msg = document.createElement('span');
    msg.className = 'status-text';
    msg.textContent = 'Conexão de streaming interrompida.';

    const reconnectBtn = document.createElement('button');
    reconnectBtn.type = 'button';
    reconnectBtn.className = 'pipeline-reconnect-btn';
    reconnectBtn.setAttribute('data-reconnect-turn', String(turnId));
    reconnectBtn.textContent = '↻ Reconectar';

    mainRow.appendChild(dot);
    mainRow.appendChild(msg);
    mainRow.appendChild(reconnectBtn);
    wrapper.appendChild(mainRow);

    statusSlot.replaceChildren(wrapper);
  }

  function connectTurnStream(turnId, options) {
    const key = String(turnId || '').trim();
    if (!key) return;

    const opts = typeof options === 'boolean' ? { shouldScroll: options } : (options || {});
    const shouldScroll = opts.shouldScroll !== false;

    // Fecha stream anterior do mesmo turno (evita concorrência e garante geração única)
    closeTurnStream(key);

    const generation = ++streamGenerationCounter;
    const startedAt = Date.now();

    const turnCard = document.getElementById(`turn-${key}`);
    const streamContainer = document.getElementById(`sse-container-${key}`);
    const statusSlot = document.getElementById(`turn-status-${key}`);
    const answerSlot = document.getElementById(`turn-answer-${key}`);
    const sourcesSlot = document.getElementById(`turn-sources-${key}`);

    if (turnCard) turnCard.classList.add('turn-card-live');
    if (answerSlot) answerSlot.setAttribute('aria-busy', 'true');

    if (shouldScroll) {
      scrollTurnToTop(key);
    }

    const es = new window.EventSource(`/stream/${encodeURIComponent(key)}`);

    const timerInterval = window.setInterval(() => {
      const current = activeStreams.get(key);
      if (!current || current.generation !== generation) {
        clearInterval(timerInterval);
        return;
      }
      updateLiveTimerDom(key, startedAt);
    }, 100);

    activeStreams.set(key, {
      es,
      generation,
      timerInterval,
      startedAt
    });

    const isCurrent = () => {
      const cur = activeStreams.get(key);
      return Boolean(cur && cur.generation === generation);
    };

    es.addEventListener('status', (e) => {
      if (!isCurrent()) return;
      const slot = document.getElementById(`turn-status-${key}`);
      if (slot && e.data) {
        slot.innerHTML = e.data;
        updateLiveTimerDom(key, startedAt);
      }
    });

    es.addEventListener('sources', (e) => {
      if (!isCurrent()) return;
      const slot = document.getElementById(`turn-sources-${key}`);
      if (slot && e.data) {
        slot.innerHTML = e.data;
        smartScrollToBottom();
      }
    });

    es.addEventListener('answer', (e) => {
      if (!isCurrent()) return;
      const slot = document.getElementById(`turn-answer-${key}`);
      if (slot && e.data) {
        hideActiveCitationPopover();
        slot.innerHTML = e.data;
        smartScrollToBottom();
      }
    });

    es.addEventListener('done', () => {
      if (!isCurrent()) return;
      closeTurnStream(key);
      const card = document.getElementById(`turn-${key}`);
      if (card) card.classList.remove('turn-card-live');
      const ans = document.getElementById(`turn-answer-${key}`);
      if (ans) ans.setAttribute('aria-busy', 'false');
      if (streamContainer) streamContainer.removeAttribute('data-stream-turn');
      resetRewriteButton(key);
    });

    es.onerror = () => {
      if (!isCurrent()) return;
      closeTurnStream(key);
      const card = document.getElementById(`turn-${key}`);
      if (card) card.classList.remove('turn-card-live');
      const ans = document.getElementById(`turn-answer-${key}`);
      if (ans) ans.setAttribute('aria-busy', 'false');
      resetRewriteButton(key);
      const slot = document.getElementById(`turn-status-${key}`);
      renderReconnectBanner(key, slot);
    };
  }

  function ensureLiveStreamsConnected(root) {
    pruneOrphanStreams();
    const containers = (root || document).querySelectorAll('[data-stream-turn]');
    containers.forEach((container) => {
      const turnId = container.getAttribute('data-stream-turn');
      if (turnId && !activeStreams.has(String(turnId))) {
        connectTurnStream(turnId, { shouldScroll: true });
      }
    });
  }

  // =========================================================================
  // 5. Popover Flutuante de Citação (WCAG 1.4.13 — Hoverable, Dismissible, Persistent)
  // =========================================================================
  function clearCitationCloseTimer() {
    if (citationCloseTimer) {
      clearTimeout(citationCloseTimer);
      citationCloseTimer = null;
    }
  }

  function hideActiveCitationPopover() {
    clearCitationCloseTimer();
    if (activeCitationPopover) {
      activeCitationPopover.classList.remove('is-open');
      activeCitationPopover.setAttribute('aria-hidden', 'true');
      activeCitationPopover.style.left = '';
      activeCitationPopover.style.top = '';
    }
    activeCitationRef = null;
    activeCitationPopover = null;
  }

  function positionCitationPopover(triggerEl, popoverEl) {
    if (!triggerEl || !popoverEl) return;
    const rect = triggerEl.getBoundingClientRect();
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const vh = window.innerHeight || document.documentElement.clientHeight;

    // Se o trigger saiu da tela, fecha
    if (rect.bottom < 0 || rect.top > vh) {
      hideActiveCitationPopover();
      return;
    }

    const margin = 12;
    const popWidth = Math.min(330, vw - margin * 2);
    popoverEl.style.width = `${popWidth}px`;

    // Mede altura após mostrar
    const popRect = popoverEl.getBoundingClientRect();
    const popHeight = popRect.height || 140;

    let left = rect.left + rect.width / 2 - popWidth / 2;
    left = Math.max(margin, Math.min(left, vw - popWidth - margin));

    let top = rect.top - popHeight - 8;
    if (top < margin) {
      top = rect.bottom + 8;
    }
    if (top + popHeight > vh - margin) {
      top = Math.max(margin, vh - popHeight - margin);
    }

    popoverEl.style.left = `${Math.round(left)}px`;
    popoverEl.style.top = `${Math.round(top)}px`;
  }

  function openCitationPopover(refEl) {
    if (!refEl) return;
    const popoverEl = refEl.querySelector('.citation-popover');
    const triggerEl = refEl.querySelector('.citation-link');
    if (!popoverEl || !triggerEl) return;

    clearCitationCloseTimer();
    if (activeCitationPopover && activeCitationPopover !== popoverEl) {
      hideActiveCitationPopover();
    }

    activeCitationRef = refEl;
    activeCitationPopover = popoverEl;
    popoverEl.classList.add('is-open');
    popoverEl.setAttribute('aria-hidden', 'false');
    positionCitationPopover(triggerEl, popoverEl);
  }

  function scheduleCloseCitationPopover() {
    clearCitationCloseTimer();
    citationCloseTimer = window.setTimeout(() => {
      hideActiveCitationPopover();
    }, 160);
  }

  document.addEventListener('mouseover', (event) => {
    const refEl = event.target.closest('.footnote-ref');
    if (refEl) {
      openCitationPopover(refEl);
      return;
    }
    if (activeCitationPopover && activeCitationPopover.contains(event.target)) {
      clearCitationCloseTimer();
    }
  });

  document.addEventListener('mouseout', (event) => {
    if (!activeCitationRef) return;
    const related = event.relatedTarget;
    if (related && (activeCitationRef.contains(related) || (activeCitationPopover && activeCitationPopover.contains(related)))) {
      return;
    }
    const leavingRef = event.target.closest('.footnote-ref');
    if (leavingRef === activeCitationRef) {
      scheduleCloseCitationPopover();
    }
  });

  document.addEventListener('focusin', (event) => {
    const refEl = event.target.closest('.footnote-ref');
    if (refEl) {
      openCitationPopover(refEl);
    } else if (activeCitationRef && !activeCitationRef.contains(event.target)) {
      hideActiveCitationPopover();
    }
  });

  window.addEventListener(
    'scroll',
    () => {
      if (activeCitationRef && activeCitationPopover) {
        const triggerEl = activeCitationRef.querySelector('.citation-link');
        positionCitationPopover(triggerEl, activeCitationPopover);
      }
    },
    { passive: true }
  );

  window.addEventListener('resize', () => {
    if (activeCitationRef && activeCitationPopover) {
      const triggerEl = activeCitationRef.querySelector('.citation-link');
      positionCitationPopover(triggerEl, activeCitationPopover);
    }
    if (!isMobileViewport()) {
      closeMobileDrawer(false);
      closeMobileOptionsPopover();
    }
  });

  // =========================================================================
  // 6. Combobox Pesquisável para Modelos Ollama (81+ modelos) + Persistência 4 Controles
  // =========================================================================
  function updateTopModelBadge(modelName) {
    const topBadge = document.getElementById('top-bar-llm-badge');
    if (!topBadge || !modelName) return;

    const dot = document.createElement('span');
    dot.className = 'status-dot-inline';
    dot.setAttribute('aria-hidden', 'true');

    const nameSpan = document.createElement('span');
    nameSpan.className = 'topbar-model-name';
    nameSpan.textContent = String(modelName);

    topBadge.replaceChildren(dot, nameSpan);
  }

  function readModelCatalogFromSelect(selectEl) {
    if (!selectEl) return [];
    return Array.from(selectEl.options).map((opt) => {
      const name = opt.value;
      const fullLabel = opt.textContent || name;
      const badgeMatch = fullLabel.match(/\(([^)]+)\)\s*$/);
      const badge = badgeMatch ? badgeMatch[1] : '';
      return {
        name,
        label: fullLabel,
        badge
      };
    });
  }

  function closeModelCombobox(restoreValue) {
    const inputEl = document.getElementById('model-combobox-input');
    const popoverEl = document.getElementById('model-combobox-popover');
    const selectEl = document.getElementById('model-select');
    comboboxOpen = false;
    comboboxActiveIndex = -1;
    if (popoverEl) popoverEl.hidden = true;
    if (inputEl) {
      inputEl.setAttribute('aria-expanded', 'false');
      inputEl.removeAttribute('aria-activedescendant');
      if (restoreValue && selectEl && selectEl.value) {
        inputEl.value = selectEl.value;
      }
    }
  }

  function selectModelValue(modelName) {
    const selectEl = document.getElementById('model-select');
    const inputEl = document.getElementById('model-combobox-input');
    if (!selectEl || !modelName) return;

    const exists = Array.from(selectEl.options).some((opt) => opt.value === modelName);
    if (!exists) return;

    selectEl.value = modelName;
    selectEl.dataset.activeModel = modelName;
    if (inputEl) {
      inputEl.value = modelName;
    }
    safeStorageSet(STORAGE_KEYS.model, modelName);
    updateTopModelBadge(modelName);
    selectEl.dispatchEvent(new Event('change', { bubbles: true }));
    closeModelCombobox(false);
  }

  function renderModelComboboxList(filterQuery) {
    const listboxEl = document.getElementById('model-combobox-listbox');
    const countEl = document.getElementById('model-combobox-count');
    const inputEl = document.getElementById('model-combobox-input');
    const selectEl = document.getElementById('model-select');
    if (!listboxEl) return;

    const currentVal = selectEl ? selectEl.value : '';
    const terms = String(filterQuery || '')
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);

    comboboxFiltered = terms.length === 0
      ? modelCatalog.slice()
      : modelCatalog.filter((item) => {
          const hay = `${item.name} ${item.badge}`.toLowerCase();
          return terms.every((t) => hay.includes(t));
        });

    if (countEl) {
      countEl.textContent =
        comboboxFiltered.length === modelCatalog.length
          ? `${modelCatalog.length} modelos disponíveis`
          : `${comboboxFiltered.length} de ${modelCatalog.length} modelos`;
    }

    const fragment = document.createDocumentFragment();
    if (comboboxFiltered.length === 0) {
      const emptyLi = document.createElement('li');
      emptyLi.className = 'model-combobox-empty';
      emptyLi.setAttribute('role', 'option');
      emptyLi.setAttribute('aria-disabled', 'true');
      emptyLi.textContent = 'Nenhum modelo encontrado.';
      fragment.appendChild(emptyLi);
      comboboxActiveIndex = -1;
    } else {
      let defaultIdx = comboboxFiltered.findIndex((item) => item.name === currentVal);
      if (defaultIdx === -1) defaultIdx = 0;
      if (comboboxActiveIndex < 0 || comboboxActiveIndex >= comboboxFiltered.length) {
        comboboxActiveIndex = defaultIdx;
      }

      comboboxFiltered.forEach((item, idx) => {
        const li = document.createElement('li');
        li.id = `model-opt-${idx}`;
        li.className = 'model-combobox-option';
        if (item.name === currentVal) li.classList.add('is-selected');
        if (idx === comboboxActiveIndex) li.classList.add('is-active');
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', item.name === currentVal ? 'true' : 'false');
        li.dataset.modelValue = item.name;

        const nameSpan = document.createElement('span');
        nameSpan.className = 'model-opt-name';
        nameSpan.textContent = item.name;
        li.appendChild(nameSpan);

        if (item.badge) {
          const badgeSpan = document.createElement('span');
          badgeSpan.className = 'model-opt-badge tabular-nums';
          badgeSpan.textContent = item.badge;
          li.appendChild(badgeSpan);
        }

        fragment.appendChild(li);
      });
    }

    listboxEl.replaceChildren(fragment);

    if (inputEl && comboboxActiveIndex >= 0 && comboboxFiltered[comboboxActiveIndex]) {
      const activeId = `model-opt-${comboboxActiveIndex}`;
      inputEl.setAttribute('aria-activedescendant', activeId);
      const activeEl = document.getElementById(activeId);
      if (activeEl && typeof activeEl.scrollIntoView === 'function') {
        activeEl.scrollIntoView({ block: 'nearest' });
      }
    } else if (inputEl) {
      inputEl.removeAttribute('aria-activedescendant');
    }
  }

  function openModelCombobox(showAll) {
    const inputEl = document.getElementById('model-combobox-input');
    const popoverEl = document.getElementById('model-combobox-popover');
    const selectEl = document.getElementById('model-select');
    if (!inputEl || !popoverEl || !selectEl) return;

    modelCatalog = readModelCatalogFromSelect(selectEl);
    comboboxOpen = true;
    popoverEl.hidden = false;
    inputEl.setAttribute('aria-expanded', 'true');

    // Decide direção de abertura (acima vs abaixo) conforme viewport
    const inputRect = inputEl.getBoundingClientRect();
    const spaceBelow = (window.innerHeight || 800) - inputRect.bottom;
    const spaceAbove = inputRect.top;
    if (spaceBelow < 260 && spaceAbove > spaceBelow) {
      popoverEl.classList.add('opens-up');
    } else {
      popoverEl.classList.remove('opens-up');
    }

    comboboxActiveIndex = -1;
    renderModelComboboxList(showAll ? '' : inputEl.value);
  }

  function updateComboboxHighlight(newIndex) {
    if (comboboxFiltered.length === 0) return;
    const bounded = Math.max(0, Math.min(newIndex, comboboxFiltered.length - 1));
    comboboxActiveIndex = bounded;

    const listboxEl = document.getElementById('model-combobox-listbox');
    const inputEl = document.getElementById('model-combobox-input');
    if (!listboxEl) return;

    const options = listboxEl.querySelectorAll('.model-combobox-option');
    options.forEach((el, idx) => {
      el.classList.toggle('is-active', idx === bounded);
    });

    const activeEl = options[bounded];
    if (activeEl) {
      if (inputEl) inputEl.setAttribute('aria-activedescendant', activeEl.id);
      if (typeof activeEl.scrollIntoView === 'function') {
        activeEl.scrollIntoView({ block: 'nearest' });
      }
    }
  }

  function bindModelCombobox(root) {
    const inputEl = (root || document).querySelector('#model-combobox-input');
    const toggleBtn = (root || document).querySelector('#model-combobox-toggle');
    const listboxEl = (root || document).querySelector('#model-combobox-listbox');
    const selectEl = (root || document).querySelector('#model-select');

    if (!inputEl || !selectEl) return;

    modelCatalog = readModelCatalogFromSelect(selectEl);
    if (selectEl.value) {
      inputEl.value = selectEl.value;
    }

    if (inputEl.dataset.comboboxBound) return;
    inputEl.dataset.comboboxBound = '1';

    inputEl.addEventListener('focus', () => {
      openModelCombobox(true);
      inputEl.select();
    });

    inputEl.addEventListener('input', () => {
      if (!comboboxOpen) {
        openModelCombobox(false);
      } else {
        comboboxActiveIndex = 0;
        renderModelComboboxList(inputEl.value);
      }
    });

    inputEl.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        if (!comboboxOpen) {
          openModelCombobox(true);
        } else {
          updateComboboxHighlight(comboboxActiveIndex + 1);
        }
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        if (!comboboxOpen) {
          openModelCombobox(true);
        } else {
          updateComboboxHighlight(comboboxActiveIndex - 1);
        }
      } else if (event.key === 'Home' && comboboxOpen) {
        event.preventDefault();
        updateComboboxHighlight(0);
      } else if (event.key === 'End' && comboboxOpen) {
        event.preventDefault();
        updateComboboxHighlight(comboboxFiltered.length - 1);
      } else if (event.key === 'Enter' && comboboxOpen) {
        event.preventDefault();
        if (comboboxActiveIndex >= 0 && comboboxFiltered[comboboxActiveIndex]) {
          selectModelValue(comboboxFiltered[comboboxActiveIndex].name);
        } else {
          closeModelCombobox(true);
        }
      } else if (event.key === 'Escape' && comboboxOpen) {
        event.preventDefault();
        event.stopPropagation();
        closeModelCombobox(true);
      } else if (event.key === 'Tab' && comboboxOpen) {
        closeModelCombobox(true);
      }
    });

    if (toggleBtn && !toggleBtn.dataset.comboboxBound) {
      toggleBtn.dataset.comboboxBound = '1';
      toggleBtn.addEventListener('mousedown', (event) => {
        event.preventDefault();
        if (comboboxOpen) {
          closeModelCombobox(true);
        } else {
          inputEl.focus();
          openModelCombobox(true);
        }
      });
    }

    if (listboxEl && !listboxEl.dataset.comboboxBound) {
      listboxEl.dataset.comboboxBound = '1';
      listboxEl.addEventListener('mousedown', (event) => {
        const opt = event.target.closest('.model-combobox-option');
        if (!opt) return;
        event.preventDefault();
        const val = opt.dataset.modelValue;
        if (val) selectModelValue(val);
      });
    }
  }

  function syncPersistentControls(root) {
    const scopeRoot = root || document;

    const pairs = [
      { selector: '#scope-select', key: STORAGE_KEYS.scope },
      { selector: '#lang-select', key: STORAGE_KEYS.lang },
      { selector: '#focus-select', key: STORAGE_KEYS.focus }
    ];

    pairs.forEach(({ selector, key }) => {
      const el = scopeRoot.querySelector(selector);
      if (!el) return;
      const saved = safeStorageGet(key);
      if (saved && Array.from(el.options).some((opt) => opt.value === saved)) {
        el.value = saved;
      }
      if (!el.dataset.persistBound) {
        el.dataset.persistBound = '1';
        el.addEventListener('change', () => {
          safeStorageSet(key, el.value);
        });
      }
    });

    const selectEl = scopeRoot.querySelector('#model-select');
    if (selectEl) {
      const savedModel = safeStorageGet(STORAGE_KEYS.model);
      if (savedModel && Array.from(selectEl.options).some((opt) => opt.value === savedModel)) {
        selectEl.value = savedModel;
      }
      updateTopModelBadge(selectEl.value);

      if (!selectEl.dataset.modelBound) {
        selectEl.dataset.modelBound = '1';
        selectEl.addEventListener('change', () => {
          safeStorageSet(STORAGE_KEYS.model, selectEl.value);
          updateTopModelBadge(selectEl.value);
          const inputEl = document.getElementById('model-combobox-input');
          if (inputEl && document.activeElement !== inputEl) {
            inputEl.value = selectEl.value;
          }
        });
      }

      bindModelCombobox(scopeRoot);
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

      const savedModel = safeStorageGet(STORAGE_KEYS.model) || selectEl.value || data.defaultModel;
      const fragment = document.createDocumentFragment();

      data.models.forEach((m) => {
        const name = typeof m === 'string' ? m : String(m?.name || '');
        if (!name) return;
        const rawBadge =
          typeof m === 'object' && m !== null
            ? (m.parameterSize || (m.sizeGb ? (m.sizeGb === 'Cloud' ? 'Cloud' : `${m.sizeGb}GB`) : ''))
            : '';
        const option = document.createElement('option');
        option.value = name;
        option.textContent = rawBadge ? `${name} (${rawBadge})` : name;
        if (name === savedModel) {
          option.selected = true;
        }
        fragment.appendChild(option);
      });

      selectEl.replaceChildren(fragment);
      syncPersistentControls(document);
    } catch (_) {
      // Ignora silenciosamente se offline
    }
  }

  // =========================================================================
  // 7. Sidebar: Busca Instantânea, Collapse Desktop & Mobile Drawer + Focus Trap
  // =========================================================================
  function applySidebarFilter() {
    const inputEl = document.getElementById('sidebar-search-input');
    const navEl = document.getElementById('sidebar-conversations');
    if (!navEl) return;

    const query = inputEl ? inputEl.value.trim().toLowerCase() : '';
    const rows = navEl.querySelectorAll('.sidebar-item-row');
    let visibleCount = 0;

    rows.forEach((row) => {
      const title = row.getAttribute('data-search-title') || row.textContent.toLowerCase();
      const matches = !query || title.includes(query);
      row.hidden = !matches;
      if (matches) visibleCount += 1;
    });

    const noMatchesEl = document.getElementById('sidebar-no-matches');
    if (noMatchesEl) {
      noMatchesEl.hidden = visibleCount > 0 || rows.length === 0;
    }

    const totalBadge = document.getElementById('sidebar-total-count');
    if (totalBadge) {
      totalBadge.textContent = String(rows.length);
    }
  }

  function bindSidebarSearch() {
    const inputEl = document.getElementById('sidebar-search-input');
    if (!inputEl || inputEl.dataset.searchBound) return;
    inputEl.dataset.searchBound = '1';
    inputEl.addEventListener('input', applySidebarFilter);
    inputEl.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && inputEl.value) {
        event.preventDefault();
        event.stopPropagation();
        inputEl.value = '';
        applySidebarFilter();
      }
    });
  }

  function applyDesktopSidebarState() {
    const shell = document.getElementById('app-shell');
    const expandBtn = document.getElementById('sidebar-expand-btn');
    if (!shell) return;
    const collapsed = safeStorageGet(STORAGE_KEYS.sidebarCollapsed) === '1';
    shell.classList.toggle('sidebar-collapsed', collapsed);
    if (expandBtn) {
      expandBtn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    }
  }

  function toggleDesktopSidebar(collapse) {
    const shell = document.getElementById('app-shell');
    const expandBtn = document.getElementById('sidebar-expand-btn');
    if (!shell) return;
    shell.classList.toggle('sidebar-collapsed', collapse);
    safeStorageSet(STORAGE_KEYS.sidebarCollapsed, collapse ? '1' : '0');
    if (expandBtn) {
      expandBtn.setAttribute('aria-expanded', collapse ? 'false' : 'true');
    }
  }

  function getFocusableInSidebar() {
    const sidebar = document.getElementById('app-sidebar');
    if (!sidebar) return [];
    const selector = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
    return Array.from(sidebar.querySelectorAll(selector)).filter((el) => {
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && !el.closest('[hidden]');
    });
  }

  function openMobileDrawer() {
    const shell = document.getElementById('app-shell');
    const backdrop = document.getElementById('sidebar-backdrop');
    const menuBtn = document.getElementById('mobile-menu-btn');
    if (!shell) return;

    drawerPreviouslyFocused = document.activeElement;
    shell.classList.add('drawer-open');
    document.body.classList.add('no-scroll');
    if (backdrop) backdrop.hidden = false;
    if (menuBtn) menuBtn.setAttribute('aria-expanded', 'true');

    const closeBtn = document.getElementById('mobile-close-drawer-btn');
    const focusables = getFocusableInSidebar();
    const target = closeBtn || focusables[0];
    if (target) {
      window.setTimeout(() => target.focus(), 30);
    }
  }

  function closeMobileDrawer(restoreFocus) {
    const shell = document.getElementById('app-shell');
    const backdrop = document.getElementById('sidebar-backdrop');
    const menuBtn = document.getElementById('mobile-menu-btn');
    if (!shell || !shell.classList.contains('drawer-open')) return;

    shell.classList.remove('drawer-open');
    document.body.classList.remove('no-scroll');
    if (backdrop) backdrop.hidden = true;
    if (menuBtn) menuBtn.setAttribute('aria-expanded', 'false');

    if (restoreFocus) {
      const target = menuBtn || drawerPreviouslyFocused;
      if (target && typeof target.focus === 'function') {
        target.focus();
      }
    }
    drawerPreviouslyFocused = null;
  }

  function closeMobileOptionsPopover() {
    const deck = document.getElementById('composer-control-deck');
    const toggleBtn = document.getElementById('mobile-options-toggle');
    if (deck) deck.classList.remove('mobile-open');
    if (toggleBtn) toggleBtn.setAttribute('aria-expanded', 'false');
  }

  // =========================================================================
  // 8. Cópia Limpa de Resposta e Blocos de Código (sem double-click bug)
  // =========================================================================
  function copyTextToClipboard(text) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      return navigator.clipboard.writeText(text);
    }
    return new Promise((resolve, reject) => {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  }

  function extractCleanAnswerText(proseEl) {
    if (!proseEl) return '';
    const clone = proseEl.cloneNode(true);
    clone.querySelectorAll('.citation-popover, .citation-host, .code-block-header').forEach((el) => {
      el.remove();
    });
    return (clone.innerText || clone.textContent || '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function showTemporaryButtonFeedback(buttonEl, labelSelector, feedbackText) {
    const targetEl = labelSelector ? (buttonEl.querySelector(labelSelector) || buttonEl) : buttonEl;
    if (!buttonEl.dataset.origLabel) {
      buttonEl.dataset.origLabel = targetEl.textContent || '';
    }
    if (buttonEl._copyResetTimer) {
      clearTimeout(buttonEl._copyResetTimer);
    }
    targetEl.textContent = feedbackText;
    buttonEl.classList.add('is-copied');
    buttonEl._copyResetTimer = window.setTimeout(() => {
      targetEl.textContent = buttonEl.dataset.origLabel || '';
      buttonEl.classList.remove('is-copied');
      buttonEl._copyResetTimer = null;
    }, 1800);
  }

  // =========================================================================
  // 9. Banner Inline de Erro no Composer (400/500 em POST /ask)
  // =========================================================================
  function showComposerError(message) {
    const slot = document.getElementById('composer-error-slot');
    if (!slot) return;
    slot.textContent = String(message || 'Não foi possível enviar a pesquisa.');
    slot.hidden = false;
  }

  function clearComposerError() {
    const slot = document.getElementById('composer-error-slot');
    if (!slot) return;
    slot.textContent = '';
    slot.hidden = true;
  }

  // =========================================================================
  // 10. Delegação de Teclado (Enter, /, Ctrl+K, Esc, Focus Trap no Drawer)
  // =========================================================================
  document.addEventListener('keydown', (event) => {
    // Focus trap dentro da sidebar no mobile drawer
    const shell = document.getElementById('app-shell');
    if (event.key === 'Tab' && shell && shell.classList.contains('drawer-open')) {
      const focusables = getFocusableInSidebar();
      if (focusables.length > 0) {
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
          return;
        }
        if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
          return;
        }
      }
    }

    // Enter no composer (Shift+Enter quebra linha)
    const target = event.target;
    if (target && target.id === 'question-input' && event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      const form = target.closest('form');
      if (form && target.value.trim().length > 0) {
        if (typeof form.requestSubmit === 'function') {
          form.requestSubmit();
        } else if (window.htmx) {
          window.htmx.trigger(form, 'submit');
        }
      }
      return;
    }

    // Ctrl+K / Cmd+K -> focar campo de busca principal
    if ((event.ctrlKey || event.metaKey) && String(event.key || '').toLowerCase() === 'k') {
      event.preventDefault();
      const input = document.getElementById('question-input');
      if (input) {
        input.focus();
        input.select();
      }
      return;
    }

    // Tecla '/' fora de campos editáveis -> focar campo de busca principal
    if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey && !isEditableTarget(target)) {
      event.preventDefault();
      const input = document.getElementById('question-input');
      if (input) input.focus();
      return;
    }

    // Escape -> ordem determinística: popover citação -> combobox -> opções mobile -> drawer -> stop stream
    if (event.key === 'Escape') {
      if (activeCitationPopover) {
        event.preventDefault();
        hideActiveCitationPopover();
        return;
      }
      if (comboboxOpen) {
        event.preventDefault();
        closeModelCombobox(true);
        return;
      }
      const deck = document.getElementById('composer-control-deck');
      if (deck && deck.classList.contains('mobile-open')) {
        event.preventDefault();
        closeMobileOptionsPopover();
        const toggleBtn = document.getElementById('mobile-options-toggle');
        if (toggleBtn) toggleBtn.focus();
        return;
      }
      if (shell && shell.classList.contains('drawer-open')) {
        event.preventDefault();
        closeMobileDrawer(true);
        return;
      }
      const activeStopBtn = document.querySelector('[data-stop-turn]:not([disabled])');
      if (activeStopBtn) {
        event.preventDefault();
        activeStopBtn.click();
      }
    }
  });

  // =========================================================================
  // 11. Delegação de Cliques Unificada
  // =========================================================================
  document.addEventListener('click', (event) => {
    const target = event.target;

    // Fecha combobox ao clicar fora
    if (comboboxOpen && !target.closest('#model-combobox-wrap')) {
      closeModelCombobox(true);
    }

    // Fecha popover de opções mobile ao clicar fora
    const deck = document.getElementById('composer-control-deck');
    if (
      deck &&
      deck.classList.contains('mobile-open') &&
      !target.closest('#composer-control-deck') &&
      !target.closest('#mobile-options-toggle')
    ) {
      closeMobileOptionsPopover();
    }

    // Toggle sidebar desktop
    if (target.closest('#sidebar-collapse-btn')) {
      toggleDesktopSidebar(true);
      return;
    }
    if (target.closest('#sidebar-expand-btn')) {
      toggleDesktopSidebar(false);
      return;
    }

    // Mobile drawer abrir/fechar
    if (target.closest('#mobile-menu-btn')) {
      openMobileDrawer();
      return;
    }
    if (target.closest('#mobile-close-drawer-btn') || target.id === 'sidebar-backdrop') {
      closeMobileDrawer(true);
      return;
    }

    // Fecha mobile drawer ao clicar em item do histórico ou Nova Pesquisa
    if (isMobileViewport() && (target.closest('.sidebar-item-link') || target.closest('.new-thread-btn') || target.closest('.brand-logo'))) {
      closeMobileDrawer(false);
    }

    // Toggle opções mobile (Tier 2)
    const mobileOptBtn = target.closest('#mobile-options-toggle');
    if (mobileOptBtn && deck) {
      const willOpen = !deck.classList.contains('mobile-open');
      deck.classList.toggle('mobile-open', willOpen);
      mobileOptBtn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
      return;
    }

    // Chips de sugestão / follow-up
    const chip = target.closest('[data-suggest]');
    if (chip) {
      const suggestion = chip.getAttribute('data-suggest');
      const textarea = document.getElementById('question-input');
      const form = document.getElementById('ask-form');
      if (textarea && form && suggestion) {
        chip.classList.add('is-triggered');
        textarea.value = suggestion;
        syncTextareaGrowMirror(textarea);
        if (typeof form.requestSubmit === 'function') {
          form.requestSubmit();
        } else if (window.htmx) {
          window.htmx.trigger(form, 'submit');
        }
      }
      return;
    }

    // Botão "Copiar código" em blocos <pre>
    const copyCodeBtn = target.closest('[data-copy-code]');
    if (copyCodeBtn) {
      const wrap = copyCodeBtn.closest('.code-block-wrap');
      const codeEl = wrap ? wrap.querySelector('pre code') : null;
      if (codeEl) {
        const rawCode = codeEl.textContent || '';
        copyTextToClipboard(rawCode)
          .then(() => showTemporaryButtonFeedback(copyCodeBtn, null, 'Copiado'))
          .catch(() => {});
      }
      return;
    }

    // Botão "Copiar" resposta (texto limpo sem pílulas nem popovers)
    const copyBtn = target.closest('[data-copy-turn]');
    if (copyBtn) {
      const turnId = copyBtn.getAttribute('data-copy-turn');
      const proseEl = document.getElementById(`answer-prose-${turnId}`) || document.getElementById(`turn-answer-${turnId}`);
      if (proseEl) {
        const cleanText = extractCleanAnswerText(proseEl);
        copyTextToClipboard(cleanText)
          .then(() => showTemporaryButtonFeedback(copyBtn, '.copy-btn-label', 'Copiado'))
          .catch(() => {});
      }
      return;
    }

    // Botão "↻ Reconectar" após erro de SSE
    const reconnectBtn = target.closest('[data-reconnect-turn]');
    if (reconnectBtn) {
      const turnId = reconnectBtn.getAttribute('data-reconnect-turn');
      if (turnId) {
        connectTurnStream(turnId, { shouldScroll: false });
      }
      return;
    }

    // Botão "Traduzir" (Streaming SSE + Cache SQLite 0ms + Sync ?lang= no Exportar .md)
    const translateBtn = target.closest('[data-translate-turn]');
    if (translateBtn) {
      const turnId = translateBtn.getAttribute('data-translate-turn');
      const answerEl = document.getElementById(`turn-answer-${turnId}`);
      const langSelect = document.getElementById(`translate-lang-${turnId}`);
      const restoreBtn = document.getElementById(`restore-btn-${turnId}`);
      const modelSelect = document.getElementById('model-select');
      const exportLink = document.querySelector(`[data-export-turn="${CSS.escape(String(turnId))}"]`);
      if (!turnId || !answerEl || translateBtn.disabled) return;

      const cache = getOriginalAnswerCache();
      if (!cache.has(String(turnId))) {
        setOriginalAnswerCache(turnId, answerEl.innerHTML);
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
          if (exportLink) {
            const baseHref = exportLink.getAttribute('data-export-base') || `/turns/${encodeURIComponent(turnId)}/export.md`;
            exportLink.setAttribute('href', `${baseHref}?lang=${encodeURIComponent(targetLang)}`);
          }
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
            hideActiveCitationPopover();
            answerEl.innerHTML = e.data;
          }
        });

        es.addEventListener('done', (e) => {
          es.close();
          let meta = {};
          try {
            meta = JSON.parse(e.data || '{}');
          } catch (_) {
            // Ignora parse inválido
          }
          finishTranslation(receivedAny && !meta.error, meta);
        });

        es.addEventListener('error', () => {
          es.close();
          finishTranslation(receivedAny, {});
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
        .catch(() => finishTranslation(false, {}));
      return;
    }

    // Botão "↺ Original" (Restaurar idioma original + restaurar href do Exportar .md)
    const restoreBtn = target.closest('[data-restore-turn]');
    if (restoreBtn) {
      const turnId = restoreBtn.getAttribute('data-restore-turn');
      const answerEl = document.getElementById(`turn-answer-${turnId}`);
      const translateBtn = document.querySelector(`[data-translate-turn="${CSS.escape(String(turnId))}"]`);
      const exportLink = document.querySelector(`[data-export-turn="${CSS.escape(String(turnId))}"]`);
      const cache = getOriginalAnswerCache();

      if (turnId && answerEl && cache.has(String(turnId))) {
        hideActiveCitationPopover();
        answerEl.innerHTML = cache.get(String(turnId));
        restoreBtn.hidden = true;
        if (translateBtn) {
          const labelEl = translateBtn.querySelector('.translate-btn-label');
          if (labelEl) labelEl.textContent = 'Traduzir';
        }
        if (exportLink) {
          const baseHref = exportLink.getAttribute('data-export-base') || `/turns/${encodeURIComponent(turnId)}/export.md`;
          exportLink.setAttribute('href', baseHref);
        }
      }
      return;
    }

    // Botão "■ Parar" (com reset seguro se /stop falhar ou retornar stopped: false)
    const stopBtn = target.closest('[data-stop-turn]');
    if (stopBtn) {
      const turnId = stopBtn.getAttribute('data-stop-turn');
      if (turnId && !stopBtn.disabled) {
        const origLabel = stopBtn.getAttribute('data-orig-label') || stopBtn.textContent || '■ Parar';
        stopBtn.setAttribute('data-orig-label', origLabel);
        stopBtn.disabled = true;
        stopBtn.textContent = 'Parando…';

        const resetStopBtn = () => {
          if (document.body.contains(stopBtn)) {
            stopBtn.disabled = false;
            stopBtn.textContent = origLabel;
          }
        };

        fetch(`/turns/${encodeURIComponent(turnId)}/stop`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' }
        })
          .then((res) => (res.ok ? res.json() : Promise.reject(new Error('HTTP error'))))
          .then((data) => {
            if (!data || !data.stopped) {
              resetStopBtn();
            }
          })
          .catch(() => {
            resetStopBtn();
          });
      }
      return;
    }

    // Botão "↻ Regerar" ou "↻ Tentar novamente"
    const rewriteBtn = target.closest('[data-rewrite-turn]');
    if (rewriteBtn) {
      const turnId = rewriteBtn.getAttribute('data-rewrite-turn');
      if (!turnId || rewriteBtn.disabled) return;
      const modelSelect = document.getElementById('model-select');
      const selectedModel = modelSelect ? modelSelect.value : '';
      const labelEl = rewriteBtn.querySelector('.rewrite-btn-label');
      const origLabel = rewriteBtn.getAttribute('data-orig-label') || (labelEl ? labelEl.textContent : rewriteBtn.textContent) || '↻ Regerar';
      rewriteBtn.setAttribute('data-orig-label', origLabel);

      rewriteBtn.disabled = true;
      if (labelEl) labelEl.textContent = 'Regerando…';

      const cache = getOriginalAnswerCache();
      cache.delete(String(turnId));

      fetch(`/turns/${encodeURIComponent(turnId)}/rewrite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ model: selectedModel })
      })
        .then((res) => (res.ok ? res.json() : Promise.reject(new Error('HTTP error'))))
        .then((data) => {
          if (data && data.ok) {
            closeTurnStream(String(turnId));
            connectTurnStream(String(turnId), { shouldScroll: false });
          } else {
            resetRewriteButton(turnId);
          }
        })
        .catch(() => {
          resetRewriteButton(turnId);
        });
      return;
    }

    // Destaque da nota de rodapé ao clicar em citação [1] ou card da faixa de fontes
    const citationLink = target.closest('.citation-link, .top-source-card');
    if (citationLink) {
      hideActiveCitationPopover();
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

  // =========================================================================
  // 12. Eventos htmx (Title sync, Conversation transition sem perder foco, Delete, Erros)
  // =========================================================================
  document.body.addEventListener('deepevil:title', (event) => {
    const newTitle = event.detail && event.detail.title;
    if (typeof newTitle === 'string' && newTitle.trim()) {
      document.title = newTitle.trim();
    }
  });

  document.body.addEventListener('deepevil:conversation', (event) => {
    const detail = event.detail || {};
    const convIdInput = document.getElementById('active-conversation-id');
    const questionInput = document.getElementById('question-input');
    const submitLabel = document.getElementById('ask-submit-label');
    const stageShell = document.getElementById('stage-shell');

    if (convIdInput && detail.id) {
      convIdInput.value = String(detail.id);
    }
    if (questionInput) {
      questionInput.value = '';
      syncTextareaGrowMirror(questionInput);
      if (detail.isFollowUp) {
        questionInput.placeholder = 'Faça uma pergunta de acompanhamento (mantém o contexto)…';
      }
    }
    if (submitLabel && detail.isFollowUp) {
      submitLabel.textContent = 'Follow-up';
    }
    if (stageShell) {
      stageShell.classList.remove('stage-empty');
      stageShell.classList.add('stage-thread');
    }
    clearComposerError();
  });

  let restoreComposerFocusAfterAsk = false;

  document.body.addEventListener('htmx:beforeRequest', (event) => {
    const elt = event.detail && event.detail.elt;
    if (elt && elt.id === 'ask-form') {
      restoreComposerFocusAfterAsk = Boolean(document.activeElement && document.activeElement.id === 'question-input');
    }
  });

  document.body.addEventListener('htmx:afterRequest', (event) => {
    const elt = event.detail && event.detail.elt;
    if (elt && elt.id === 'ask-form' && restoreComposerFocusAfterAsk) {
      restoreComposerFocusAfterAsk = false;
      window.setTimeout(() => {
        const input = document.getElementById('question-input');
        if (input && !input.disabled && (!document.activeElement || document.activeElement === document.body)) {
          input.focus({ preventScroll: true });
        }
      }, 0);
    }
  });

  document.body.addEventListener('htmx:configRequest', (event) => {
    const detail = event.detail || {};
    if (detail.verb === 'delete' && String(detail.path || '').startsWith('/conversations/')) {
      const activeInput = document.getElementById('active-conversation-id');
      if (activeInput && activeInput.value) {
        detail.parameters.activeConversationId = activeInput.value;
      }
    }
    if (detail.verb === 'post' && detail.path === '/ask') {
      clearComposerError();
      closeMobileOptionsPopover();
    }
  });

  document.body.addEventListener('htmx:responseError', (event) => {
    const detail = event.detail || {};
    const elt = detail.elt;
    if (elt && elt.id === 'ask-form') {
      const xhr = detail.xhr;
      let msg = 'Não foi possível processar sua pergunta.';
      if (xhr && xhr.responseText) {
        try {
          const parsed = new window.DOMParser().parseFromString(xhr.responseText, 'text/html');
          const extracted = (parsed.body && parsed.body.textContent ? parsed.body.textContent : '').trim();
          if (extracted) msg = extracted;
        } catch (_) {
          // Mantém mensagem padrão
        }
      }
      showComposerError(msg);
    }
  });

  document.addEventListener('DOMContentLoaded', () => {
    applyDesktopSidebarState();
    bindSidebarSearch();
    applySidebarFilter();
    bindTextareaAutoGrow(document);
    syncPersistentControls(document);
    refreshOllamaModelsDropdown();
    ensureLiveStreamsConnected(document);
  });

  document.body.addEventListener('htmx:afterSwap', (event) => {
    hideActiveCitationPopover();
    closeModelCombobox(false);
    applyDesktopSidebarState();
    bindSidebarSearch();
    applySidebarFilter();
    bindTextareaAutoGrow(event.target);
    syncPersistentControls(document);
    ensureLiveStreamsConnected(document);
  });

  document.body.addEventListener('htmx:oobAfterSwap', () => {
    pruneOrphanStreams();
    applySidebarFilter();
    bindTextareaAutoGrow(document);
    syncPersistentControls(document);
  });
})();
