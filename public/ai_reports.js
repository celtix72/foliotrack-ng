/**
 * FolioTrack AI Reports & Monte Carlo Frontend Controller
 */

(function () {
  let monteCarloChart = null;
  let lastSimulationData = null;
  let lastAiAnalysisData = null;
  const chatHistory = [];
  let isAiGenerating = false;

  const fmtEur = (v) => '€ ' + (Number(v) || 0).toLocaleString('it-IT', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  const fmtPct = (v) => (Number(v) || 0).toFixed(1) + '%';

  /**
   * Escape HTML to prevent XSS
   */
  function escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  /**
   * Lightweight, robust Markdown to HTML renderer for AI financial answers.
   */
  function renderMarkdown(md) {
    if (!md) return '';

    // First preserve code blocks
    const codeBlocks = [];
    let text = md.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (match, lang, code) => {
      const idx = codeBlocks.length;
      codeBlocks.push(`<pre class="p-3 my-2 rounded-xl bg-gray-900 text-gray-100 font-mono text-[11px] overflow-x-auto border border-white/10"><code>${escapeHtml(code.trim())}</code></pre>`);
      return `__CODE_BLOCK_${idx}__`;
    });

    // Escape raw HTML outside of code blocks
    text = escapeHtml(text);

    // Headers
    text = text.replace(/^### (.*$)/gim, '<h3 class="text-xs font-bold text-gray-900 dark:text-white uppercase tracking-wider mt-3 mb-1.5 flex items-center space-x-1.5"><span class="text-emerald-500 font-mono">▸</span><span>$1</span></h3>');
    text = text.replace(/^## (.*$)/gim, '<h2 class="text-sm font-bold text-gray-900 dark:text-white mt-4 mb-2 pb-1 border-b border-gray-100 dark:border-white/5">$1</h2>');
    text = text.replace(/^# (.*$)/gim, '<h1 class="text-base font-extrabold text-gray-900 dark:text-white mt-4 mb-2">$1</h1>');

    // Horizontal Rules
    text = text.replace(/^---$/gim, '<hr class="my-3 border-gray-200 dark:border-white/10">');

    // Blockquotes
    text = text.replace(/^> (.*$)/gim, '<blockquote class="border-l-4 border-emerald-500 pl-3 py-1 my-2 text-gray-600 dark:text-gray-300 italic bg-emerald-50/20 dark:bg-emerald-950/20 rounded-r text-xs leading-relaxed">$1</blockquote>');

    // Bold & Italic
    text = text.replace(/\*\*(.*?)\*\*/g, '<strong class="font-bold text-gray-900 dark:text-white">$1</strong>');
    text = text.replace(/__(.*?)__/g, '<strong class="font-bold text-gray-900 dark:text-white">$1</strong>');
    text = text.replace(/\*(.*?)\*/g, '<em class="italic text-gray-700 dark:text-gray-300">$1</em>');

    // Inline Code
    text = text.replace(/`([^`]+)`/g, '<code class="px-1.5 py-0.5 rounded bg-gray-100 dark:bg-white/10 font-mono text-emerald-600 dark:text-emerald-400 text-[11px]">$1</code>');

    // Markdown Tables
    const tableRegex = /((?:\|[^\n]+\|\n?)+)/g;
    text = text.replace(tableRegex, (match) => {
      const rows = match.trim().split('\n').map(r => r.trim()).filter(Boolean);
      if (rows.length < 2) return match;

      let html = '<div class="overflow-x-auto my-3"><table class="min-w-full text-xs divide-y divide-gray-200 dark:divide-white/10 border border-gray-200 dark:border-white/10 rounded-xl">';
      let isHeader = true;

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (row.includes('---')) {
          isHeader = false;
          continue;
        }

        const cols = row.split('|').slice(1, -1).map(c => c.trim());
        if (isHeader) {
          html += '<thead class="bg-gray-50 dark:bg-white/[0.03]"><tr>';
          cols.forEach(c => {
            html += `<th class="px-3 py-2 text-left font-mono font-bold text-gray-600 dark:text-gray-400 text-[11px]">${c}</th>`;
          });
          html += '</tr></thead><tbody class="divide-y divide-gray-100 dark:divide-white/5">';
        } else {
          html += '<tr class="hover:bg-gray-50/50 dark:hover:bg-white/[0.01] transition">';
          cols.forEach(c => {
            html += `<td class="px-3 py-2 font-mono text-gray-800 dark:text-gray-200">${c}</td>`;
          });
          html += '</tr>';
        }
      }

      html += '</tbody></table></div>';
      return html;
    });

    // Unordered Lists
    text = text.replace(/^\s*[-*]\s+(.*$)/gim, '<li class="flex items-start space-x-2 my-1"><span class="text-emerald-500 font-bold select-none">&bull;</span><span class="flex-1">$1</span></li>');
    text = text.replace(/((?:<li class="flex items-start space-x-2 my-1">[\s\S]*?<\/li>\n?)+)/g, '<ul class="my-2 space-y-1">$1</ul>');

    // Numbered Lists
    text = text.replace(/^\s*(\d+)\.\s+(.*$)/gim, '<li class="flex items-start space-x-2 my-1"><span class="text-emerald-500 font-mono font-bold text-xs select-none">$1.</span><span class="flex-1">$2</span></li>');

    // Restore Code Blocks
    codeBlocks.forEach((block, idx) => {
      text = text.replace(`__CODE_BLOCK_${idx}__`, block);
    });

    // Paragraph line breaks
    text = text.replace(/\n\n+/g, '<div class="h-2"></div>');

    return text;
  }

  // ==========================================
  // RETIREMENT / MONTE CARLO SIMULATION
  // ==========================================
  async function loadSavedGoals() {
    if (!document.getElementById('goalCurrentAge')) return;
    try {
      const res = await fetch('/api/goals/saved');
      const data = await res.json();
      if (data.success && data.params) {
        const p = data.params;
        const setVal = (id, val) => { const el = document.getElementById(id); if (el && val !== undefined) el.value = val; };
        setVal('goalCurrentAge', p.currentAge);
        setVal('goalRetirementAge', p.retirementAge);
        setVal('goalMonthlySavings', p.monthlySavings);
        setVal('goalMonthlyExpenses', p.monthlyExpenses);
        if (p.expectedReturn !== undefined) setVal('goalExpectedReturn', (p.expectedReturn * 100).toFixed(1));
        if (p.volatility !== undefined) setVal('goalVolatility', (p.volatility * 100).toFixed(1));
      }
    } catch (err) {
      console.warn('Error loading saved goals:', err);
    }
  }

  async function runSimulation() {
    if (!document.getElementById('goalCurrentAge')) return;
    const portfolioSelect = document.getElementById('reportPortfolioSelect');
    const portfolioId = portfolioSelect ? portfolioSelect.value : 'all';
    const currentAge = parseInt(document.getElementById('goalCurrentAge')?.value, 10);
    const retirementAge = parseInt(document.getElementById('goalRetirementAge')?.value, 10);
    const monthlySavings = parseFloat(document.getElementById('goalMonthlySavings')?.value) || 0;
    const monthlyExpenses = parseFloat(document.getElementById('goalMonthlyExpenses')?.value) || 0;
    const expectedReturn = (parseFloat(document.getElementById('goalExpectedReturn')?.value) || 7.0) / 100.0;
    const volatility = (parseFloat(document.getElementById('goalVolatility')?.value) || 14.0) / 100.0;

    const payload = {
      portfolioId: portfolioId === 'all' ? null : portfolioId,
      currentAge,
      retirementAge,
      monthlySavings,
      monthlyExpenses,
      expectedReturn,
      volatility
    };

    const runBtn = document.getElementById('runSimulationBtn');
    if (runBtn) {
      runBtn.disabled = true;
      runBtn.textContent = 'Simulazione in corso...';
    }

    try {
      const res = await fetch('/api/goals/simulate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const data = await res.json();
      if (!data.success) {
        if (runBtn) alert(data.error || 'Errore durante la simulazione.');
        return;
      }

      lastSimulationData = data;
      renderSimulationResults(data);
    } catch (err) {
      if (runBtn) alert('Errore di comunicazione: ' + err.message);
    } finally {
      if (runBtn) {
        runBtn.disabled = false;
        runBtn.textContent = 'Esegui Simulazione Monte Carlo';
      }
    }
  }

  function renderSimulationResults(data) {
    const m = data.metrics;

    const successEl = document.getElementById('statSuccessRate');
    if (successEl) {
      successEl.textContent = fmtPct(m.successRate);
      if (m.successRate >= 85) successEl.className = 'text-2xl font-bold font-mono text-emerald-600 dark:text-emerald-400 tabular-nums';
      else if (m.successRate >= 70) successEl.className = 'text-2xl font-bold font-mono text-amber-500 tabular-nums';
      else successEl.className = 'text-2xl font-bold font-mono text-rose-600 tabular-nums';
    }

    const fireNumEl = document.getElementById('statFireNumber');
    if (fireNumEl) fireNumEl.textContent = fmtEur(m.fireNumber);

    const retMedEl = document.getElementById('statRetirementMedian');
    if (retMedEl) retMedEl.textContent = fmtEur(m.wealthAtRetirementMedian);

    const sorrEl = document.getElementById('statSorrDepleted');
    if (sorrEl) {
      sorrEl.textContent = typeof m.sorrDepletedAge === 'number'
        ? `Esaurimento all'età di ${m.sorrDepletedAge} anni`
        : 'Capitale resiliente (Nessun esaurimento)';
    }

    renderMonteCarloChart(data.percentiles, data.sorr);
  }

  function renderMonteCarloChart(percentiles, sorr) {
    const canvas = document.getElementById('monteCarloChart');
    if (!canvas) return;

    if (typeof Chart === 'undefined') {
      console.warn('[AI Reports] Libreria Chart.js non caricata.');
      return;
    }

    const labels = percentiles.map(p => `Età ${p.age}`);
    const p10 = percentiles.map(p => Math.round(p.p10));
    const p50 = percentiles.map(p => Math.round(p.p50));
    const p90 = percentiles.map(p => Math.round(p.p90));
    const sorrVals = (sorr || []).map(s => Math.round(s.wealth));

    if (monteCarloChart) {
      monteCarloChart.destroy();
    }

    const isDark = document.documentElement.classList.contains('dark');

    monteCarloChart = new Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'P90 (Scenario Ottimistico)',
            data: p90,
            borderColor: 'rgba(16, 185, 129, 0.7)',
            backgroundColor: 'rgba(16, 185, 129, 0.08)',
            fill: '+1',
            tension: 0.2,
            borderDash: [4, 4],
            pointRadius: 0
          },
          {
            label: 'P50 (Mediana)',
            data: p50,
            borderColor: 'rgba(16, 185, 129, 1)',
            backgroundColor: 'transparent',
            fill: false,
            tension: 0.2,
            borderWidth: 2.5,
            pointRadius: 0
          },
          {
            label: 'P10 (Scenario Conservativo)',
            data: p10,
            borderColor: 'rgba(239, 68, 68, 0.7)',
            backgroundColor: 'transparent',
            fill: false,
            tension: 0.2,
            borderDash: [4, 4],
            pointRadius: 0
          },
          {
            label: 'SORR (Sequenza Rendimenti Avversa)',
            data: sorrVals,
            borderColor: 'rgba(245, 158, 11, 0.9)',
            backgroundColor: 'transparent',
            borderWidth: 1.8,
            pointRadius: 0,
            fill: false,
            tension: 0.1
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: true,
            labels: {
              boxWidth: 12,
              font: { family: 'JetBrains Mono', size: 10 },
              color: isDark ? '#d1d5db' : '#374151'
            }
          },
          tooltip: {
            callbacks: {
              label: (ctx) => ` ${ctx.dataset.label}: ${fmtEur(ctx.raw)}`
            }
          }
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: { maxTicksLimit: 12, font: { family: 'JetBrains Mono', size: 9 }, color: isDark ? '#9ca3af' : '#6b7280' }
          },
          y: {
            grid: { color: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)' },
            ticks: {
              font: { family: 'JetBrains Mono', size: 10 },
              color: isDark ? '#9ca3af' : '#6b7280',
              callback: (v) => '€ ' + (v >= 1000 ? (v / 1000).toFixed(0) + 'k' : v)
            }
          }
        }
      }
    });
  }

  // ==========================================
  // STRUCTURED AI ADVISOR ASSESSMENT
  // ==========================================
  async function runAiAnalysis() {
    const portfolioSelect = document.getElementById('reportPortfolioSelect');
    const portfolioId = portfolioSelect ? portfolioSelect.value : 'all';

    const providerSelect = document.getElementById('aiProviderSelect');
    const provider = providerSelect ? providerSelect.value : 'auto';

    const aiBtn = document.getElementById('runAiBtn');
    if (aiBtn) {
      aiBtn.disabled = true;
      aiBtn.textContent = 'Analisi in elaborazione...';
    }

    const container = document.getElementById('aiResultsContainer');
    if (container) container.classList.remove('hidden');
    document.getElementById('aiLoadingSpinner')?.classList.remove('hidden');
    document.getElementById('aiAnalysisContent')?.classList.add('hidden');

    try {
      const res = await fetch('/api/ai/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ portfolioId, provider })
      });

      const data = await res.json();
      if (!data.success || !data.analysis) {
        alert(data.error || 'Impossibile completare l\'analisi AI.');
        return;
      }

      lastAiAnalysisData = data.analysis;
      renderAiResults(data.analysis);
      loadSavedReportsCount();
      if (typeof refreshActiveReportsList === 'function') {
        refreshActiveReportsList();
      }
    } catch (err) {
      alert('Errore di comunicazione: ' + err.message);
    } finally {
      if (aiBtn) {
        aiBtn.disabled = false;
        aiBtn.textContent = 'Genera Analisi con AI Advisor';
      }
      document.getElementById('aiLoadingSpinner')?.classList.add('hidden');
    }
  }

  function renderAiResults(a) {
    document.getElementById('aiAnalysisContent')?.classList.remove('hidden');

    const badge = document.getElementById('aiProviderBadge');
    if (badge) badge.textContent = `${a.provider} (${a.model || ''})`;

    const riskEl = document.getElementById('aiRiskScore');
    if (riskEl) riskEl.textContent = `${a.riskScore}/100`;

    const divEl = document.getElementById('aiDiversificationScore');
    if (divEl) divEl.textContent = `${a.diversificationScore}/100`;

    const qualEl = document.getElementById('aiQualityBadge');
    if (qualEl) qualEl.textContent = a.assetAllocationQuality || 'Buona';

    const renderList = (items, elementId, bulletClass = 'text-emerald-500') => {
      const ul = document.getElementById(elementId);
      if (!ul) return;
      ul.innerHTML = (items || []).map(item => `
        <li class="flex items-start space-x-2">
          <span class="${bulletClass} font-bold select-none">&bull;</span>
          <span class="text-xs text-gray-700 dark:text-gray-300 leading-relaxed">${item}</span>
        </li>
      `).join('');
    };

    renderList(a.strengths, 'aiStrengthsList', 'text-emerald-500');
    renderList(a.weaknesses, 'aiWeaknessesList', 'text-amber-500');
    renderList(a.tacticalRecommendations, 'aiTacticalList', 'text-blue-500');
    renderList(a.strategicRecommendations, 'aiStrategicList', 'text-purple-500');

    if (a.marketContextSummary) {
      const mc = document.getElementById('aiMarketContext');
      if (mc) mc.textContent = a.marketContextSummary;
    }
  }

  // ==========================================
  // GEMINI PRO INTERACTIVE CHAT & PROMPT ENGINE
  // ==========================================
  function updateAiChatPortfolioLabel() {
    const sel = document.getElementById('reportPortfolioSelect');
    const label = document.getElementById('chatActivePortfolioLabel');
    if (sel && label) {
      const selectedText = sel.options[sel.selectedIndex]?.text || 'Globale Aggregato';
      label.textContent = `Portafoglio: ${selectedText}`;
    }
  }

  async function checkGeminiStatus() {
    try {
      const res = await fetch('/api/ai/status');
      const data = await res.json();
      const dot = document.getElementById('geminiStatusDot');
      const label = document.getElementById('geminiStatusLabel');

      const activeProviders = [];
      if (data.hasGeminiKey) activeProviders.push('Gemini');
      if (data.hasOpenRouterKey) activeProviders.push('OpenRouter');
      if (data.hasNvidiaKey) activeProviders.push('NVIDIA');
      if (data.hasOpenAiKey) activeProviders.push('OpenAI');

      if (data.success && activeProviders.length > 0) {
        if (dot) dot.className = 'w-2 h-2 rounded-full bg-emerald-500';
        if (label) label.textContent = `AI: ${activeProviders.join('+')} Attiva`;
      } else {
        if (dot) dot.className = 'w-2 h-2 rounded-full bg-amber-500 animate-pulse';
        if (label) label.textContent = '⚙️ Configura Chiavi AI';
      }

      // Update and filter model dropdowns based on active keys in settings
      updateChatModelDropdown(data);
      updateAiProviderSelect(data);
    } catch (err) {
      console.warn('Errore verifica status AI:', err);
    }
  }

  function updateChatModelDropdown(data) {
    const sel = document.getElementById('chatModelSelect');
    if (!sel) return;

    const keyMap = {
      gemini: !!data.hasGeminiKey,
      openrouter: !!data.hasOpenRouterKey,
      nvidia: !!data.hasNvidiaKey,
      openai: !!data.hasOpenAiKey
    };

    const hasAnyKey = Object.values(keyMap).some(Boolean);
    const optgroups = sel.querySelectorAll('optgroup');

    let firstActiveOptionValue = null;
    const currentSelectedValue = sel.value;
    const savedModel = localStorage.getItem('foliotrack_ai_chat_model');

    optgroups.forEach(og => {
      const prov = og.getAttribute('data-provider');
      const isActive = keyMap[prov];
      const baseLabel = og.getAttribute('data-base-label') || og.label.replace(/\s*\([^)]*\)/g, '').trim();
      if (!og.hasAttribute('data-base-label')) {
        og.setAttribute('data-base-label', baseLabel);
      }

      if (isActive) {
        og.label = `${baseLabel} (✓ Chiave Attiva)`;
        og.querySelectorAll('option').forEach(opt => {
          opt.disabled = false;
          const origText = opt.getAttribute('data-base-text') || opt.textContent.replace(/\s*\[.*?\]/g, '').trim();
          if (!opt.hasAttribute('data-base-text')) opt.setAttribute('data-base-text', origText);
          opt.textContent = origText;
          if (!firstActiveOptionValue) firstActiveOptionValue = opt.value;
        });
      } else {
        og.label = `${baseLabel} (Nessuna chiave - vedi Impostazioni)`;
        og.querySelectorAll('option').forEach(opt => {
          const origText = opt.getAttribute('data-base-text') || opt.textContent.replace(/\s*\[.*?\]/g, '').trim();
          if (!opt.hasAttribute('data-base-text')) opt.setAttribute('data-base-text', origText);
          if (hasAnyKey) {
            opt.textContent = `${origText} [Manca Chiave]`;
            opt.disabled = true;
          } else {
            opt.textContent = origText;
            opt.disabled = false;
          }
        });
      }
    });

    // Check if current selection or savedModel is valid and active
    let targetValue = null;
    if (savedModel) {
      const savedOpt = sel.querySelector(`option[value="${savedModel}"]`);
      if (savedOpt && !savedOpt.disabled) {
        targetValue = savedModel;
      }
    }

    if (!targetValue) {
      const currentOpt = sel.querySelector(`option[value="${currentSelectedValue}"]`);
      if (currentOpt && !currentOpt.disabled) {
        targetValue = currentSelectedValue;
      }
    }

    if (!targetValue && firstActiveOptionValue) {
      targetValue = firstActiveOptionValue;
    }

    if (targetValue) {
      sel.value = targetValue;
    }
    updateSendButtonLabel();
  }

  function updateSendButtonLabel() {
    const sel = document.getElementById('chatModelSelect');
    const labelEl = document.getElementById('btnSendPromptLabel');
    if (!sel || !labelEl) return;
    const opt = sel.selectedOptions?.[0];
    const prov = opt?.getAttribute('data-provider') || opt?.parentElement?.getAttribute('data-provider') || '';
    if (prov === 'openrouter') {
      labelEl.textContent = 'Invia a OpenRouter';
    } else if (prov === 'nvidia') {
      labelEl.textContent = 'Invia a NVIDIA';
    } else if (prov === 'openai') {
      labelEl.textContent = 'Invia a OpenAI';
    } else if (prov === 'gemini') {
      labelEl.textContent = 'Chiedi a Gemini';
    } else {
      labelEl.textContent = 'Invia Prompt';
    }
  }

  // ==========================================
  // CUSTOM & QUICK PROMPT CHIPS MANAGEMENT
  // ==========================================
  const SAVED_PROMPTS_KEY = 'foliotrack_saved_prompts';

  function getSavedPrompts() {
    try {
      const raw = localStorage.getItem(SAVED_PROMPTS_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (_) {
      return [];
    }
  }

  function setSavedPrompts(list) {
    try {
      localStorage.setItem(SAVED_PROMPTS_KEY, JSON.stringify(list));
    } catch (_) {}
  }

  function showPromptFeedback(message, isError = false) {
    const el = document.getElementById('promptActionFeedback');
    if (!el) return;
    el.textContent = message;
    el.className = isError
      ? 'text-[11px] font-mono text-rose-500 font-medium'
      : 'text-[11px] font-mono text-emerald-600 dark:text-emerald-400 font-medium';
    el.classList.remove('hidden');
    clearTimeout(el._timer);
    el._timer = setTimeout(() => {
      el.classList.add('hidden');
    }, 3500);
  }

  function loadPromptIntoInput(promptText) {
    const promptInput = document.getElementById('aiPromptInput');
    if (!promptInput || !promptText) return;

    promptInput.value = promptText;
    promptInput.style.height = 'auto';
    promptInput.style.height = Math.min(promptInput.scrollHeight, 180) + 'px';
    promptInput.focus();
    promptInput.setSelectionRange(promptInput.value.length, promptInput.value.length);
    promptInput.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    showPromptFeedback('✏️ Prompt pronto nell\'editor: puoi modificarlo o salvarlo prima di inviarlo.');
  }

  function renderSavedPrompts() {
    const container = document.getElementById('customPromptChipsContainer');
    if (!container) return;
    const inner = document.getElementById('customPromptChipsInner') || container;

    const saved = getSavedPrompts();
    if (!saved || saved.length === 0) {
      container.classList.add('hidden');
      inner.innerHTML = '';
      return;
    }

    container.classList.remove('hidden');
    inner.innerHTML = `
      <div class="flex items-center space-x-1 text-[10px] font-mono text-gray-400 py-0.5 w-full">
        <span>⭐ Prompt salvati:</span>
      </div>
    `;

    saved.forEach(item => {
      const chipWrapper = document.createElement('div');
      chipWrapper.className = 'inline-flex items-center rounded-lg text-xs font-mono bg-emerald-50/80 dark:bg-emerald-950/40 border border-emerald-500/30 text-emerald-700 dark:text-emerald-300 shadow-sm transition hover:border-emerald-500/70 mr-1.5 mb-1';

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'px-2.5 py-1 text-left flex items-center space-x-1 hover:text-emerald-900 dark:hover:text-emerald-100 transition';
      btn.innerHTML = `<span class="text-xs">💡</span> <span class="font-medium">${escapeHtml(item.label || item.prompt.slice(0, 20))}</span>`;
      btn.title = item.prompt;
      btn.addEventListener('click', () => loadPromptIntoInput(item.prompt));

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'px-1.5 py-1 text-gray-400 hover:text-rose-500 dark:hover:text-rose-400 transition text-xs font-bold leading-none';
      delBtn.title = 'Rimuovi dai salvati';
      delBtn.innerHTML = '&times;';
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const updated = getSavedPrompts().filter(p => p.id !== item.id);
        setSavedPrompts(updated);
        renderSavedPrompts();
        showPromptFeedback('Prompt rimosso dai suggerimenti.');
      });

      chipWrapper.appendChild(btn);
      chipWrapper.appendChild(delBtn);
      inner.appendChild(chipWrapper);
    });
  }

  function initPromptChipsLogic() {
    const promptInput = document.getElementById('aiPromptInput');

    // Quick chips click: load into input, DO NOT auto-execute immediately
    document.querySelectorAll('.quick-chip').forEach(btn => {
      btn.addEventListener('click', async () => {
        const promptType = btn.getAttribute('data-prompt-type');
        if (promptType === 'weekly-report') {
          const portfolioSelect = document.getElementById('reportPortfolioSelect');
          const portfolioId = portfolioSelect ? portfolioSelect.value : 'all';
          showPromptFeedback('Compilazione report settimanale con i dati del portafoglio in corso...');
          try {
            const res = await fetch(`/api/ai/prompts/weekly-report?portfolioId=${encodeURIComponent(portfolioId)}`);
            const data = await res.json();
            if (data.success && data.prompt) {
              loadPromptIntoInput(data.prompt);
              showPromptFeedback('✓ Report settimanale compilato con i dati del portafoglio! Puoi modificarlo o inviarlo.');
              return;
            }
          } catch (err) {
            console.warn('Errore caricamento prompt report settimanale:', err);
          }
        }

        const promptText = btn.getAttribute('data-prompt');
        if (promptText) {
          loadPromptIntoInput(promptText);
        }
      });
    });

    // Save custom prompt button
    document.getElementById('btnSaveCustomPrompt')?.addEventListener('click', () => {
      const text = promptInput?.value?.trim();
      if (!text) {
        showPromptFeedback('Scrivi o seleziona prima un prompt da salvare.', true);
        promptInput?.focus();
        return;
      }

      const defaultLabel = text.length > 25 ? text.slice(0, 22) + '...' : text;
      const userLabel = window.prompt('Inserisci un nome breve per salvare questo prompt tra i suggerimenti:', defaultLabel);
      if (userLabel === null) return;

      const label = userLabel.trim() || defaultLabel;
      const saved = getSavedPrompts();
      saved.push({
        id: Date.now(),
        label,
        prompt: text
      });
      setSavedPrompts(saved);
      renderSavedPrompts();
      showPromptFeedback('✓ Prompt salvato nei tuoi suggerimenti!');
    });

    renderSavedPrompts();
  }

  function updateAiProviderSelect(data) {
    const sel = document.getElementById('aiProviderSelect');
    if (!sel) return;

    const keyMap = {
      gemini: !!data.hasGeminiKey,
      openrouter: !!data.hasOpenRouterKey,
      nvidia: !!data.hasNvidiaKey,
      openai: !!data.hasOpenAiKey
    };

    sel.querySelectorAll('option').forEach(opt => {
      const val = opt.value;
      if (val === 'auto' || val === 'heuristic') return;
      const baseText = opt.getAttribute('data-base-text') || opt.textContent.replace(/\s*\([^)]*\)/g, '').trim();
      if (!opt.hasAttribute('data-base-text')) opt.setAttribute('data-base-text', baseText);

      if (keyMap[val]) {
        opt.textContent = `${baseText} (✓ Attivo)`;
        opt.disabled = false;
      } else {
        opt.textContent = `${baseText} (Nessuna chiave)`;
      }
    });
  }

  function appendUserMessage(text) {
    const thread = document.getElementById('aiChatThread');
    if (!thread) return;

    // Remove welcome banner if present
    document.getElementById('chatWelcomeBanner')?.classList.add('hidden');

    const msgDiv = document.createElement('div');
    msgDiv.className = 'flex justify-end';
    msgDiv.innerHTML = `
      <div class="max-w-[85%] rounded-2xl rounded-tr-sm bg-emerald-600 text-white px-4 py-2.5 text-xs shadow-sm leading-relaxed whitespace-pre-wrap">
        ${escapeHtml(text)}
      </div>
    `;
    thread.appendChild(msgDiv);
    thread.scrollTop = thread.scrollHeight;
  }

  function appendModelMessage(text, meta = {}) {
    const thread = document.getElementById('aiChatThread');
    if (!thread) return;

    const msgDiv = document.createElement('div');
    msgDiv.className = 'flex flex-col space-y-1.5 max-w-full';

    const timestamp = new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
    const modelLabel = meta.model || 'Gemini Pro';

    msgDiv.innerHTML = `
      <div class="flex items-center justify-between text-[10px] font-mono text-gray-400 px-1">
        <span class="flex items-center space-x-1 text-emerald-600 dark:text-emerald-400 font-bold">
          <span>✦</span>
          <span>${modelLabel} • ${timestamp}</span>
        </span>
        <button class="copy-btn hover:text-emerald-500 flex items-center space-x-1 transition cursor-pointer" title="Copia risposta">
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>
          <span class="copy-label">Copia</span>
        </button>
      </div>
      <div class="signature-card p-4 bg-white dark:bg-[#18181b] border border-gray-200/80 dark:border-white/10 text-xs text-gray-800 dark:text-gray-200 leading-relaxed shadow-sm space-y-2 ai-markdown-body">
        ${renderMarkdown(text)}
      </div>
    `;

    // Copy action
    const copyBtn = msgDiv.querySelector('.copy-btn');
    const copyLabel = msgDiv.querySelector('.copy-label');
    if (copyBtn) {
      copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(text).then(() => {
          if (copyLabel) copyLabel.textContent = 'Copiato!';
          setTimeout(() => { if (copyLabel) copyLabel.textContent = 'Copia'; }, 2000);
        }).catch(() => {
          if (copyLabel) copyLabel.textContent = 'Errore copia';
        });
      });
    }

    thread.appendChild(msgDiv);
    thread.scrollTop = thread.scrollHeight;
  }

  function showThinkingIndicator(modelLabel = 'AI Advisor') {
    const thread = document.getElementById('aiChatThread');
    if (!thread) return;

    const ind = document.createElement('div');
    ind.id = 'aiThinkingIndicator';
    ind.className = 'flex items-center space-x-2 text-xs font-mono text-emerald-600 dark:text-emerald-400 py-2 px-1';
    ind.innerHTML = `
      <span class="animate-spin w-3.5 h-3.5 border-2 border-emerald-500 border-t-transparent rounded-full"></span>
      <span class="animate-pulse">${escapeHtml(modelLabel)} sta analizzando il portafoglio...</span>
    `;
    thread.appendChild(ind);
    thread.scrollTop = thread.scrollHeight;
  }

  function removeThinkingIndicator() {
    document.getElementById('aiThinkingIndicator')?.remove();
  }

  async function sendAiChatPrompt(customPrompt = null) {
    if (isAiGenerating) return;

    const input = document.getElementById('aiPromptInput');
    const promptText = (customPrompt || input?.value || '').trim();
    if (!promptText) return;

    const portfolioSelect = document.getElementById('reportPortfolioSelect');
    const portfolioId = portfolioSelect ? portfolioSelect.value : 'all';

    const modelSelect = document.getElementById('chatModelSelect');
    const model = modelSelect ? modelSelect.value : 'gemini-2.0-flash';
    const selectedOpt = modelSelect?.selectedOptions?.[0];

    // Clear input
    if (input) {
      input.value = '';
      input.style.height = 'auto';
    }

    // Determine AI provider from option attribute or model
    let provider = selectedOpt?.getAttribute('data-provider') || 'auto';
    if (!provider || provider === 'auto') {
      if (selectedOpt?.parentElement?.tagName === 'OPTGROUP') {
        provider = selectedOpt.parentElement.getAttribute('data-provider') || 'auto';
      }
    }
    if (!provider || provider === 'auto') {
      if (model.includes(':free') || model.startsWith('openrouter/') || model.startsWith('deepseek/') || model.startsWith('anthropic/') || model.startsWith('meta-llama/') || model.startsWith('qwen/') || model.startsWith('mistralai/')) {
        provider = 'openrouter';
      } else if (model.startsWith('nvidia/') || model.includes('nemotron') || model.includes('ultramon')) {
        provider = 'nvidia';
      } else if (model.startsWith('gpt-')) {
        provider = 'openai';
      } else if (model.startsWith('gemini-')) {
        provider = 'gemini';
      } else if (model.includes('/')) {
        provider = 'openrouter';
      }
    }

    const modelDisplayName = selectedOpt?.textContent?.replace(/\s*\([^)]*\)/g, '')?.replace(/\[.*?\]/g, '')?.trim() || model;

    // UI Updates
    appendUserMessage(promptText);
    showThinkingIndicator(modelDisplayName);

    const sendBtn = document.getElementById('btnSendPrompt');
    if (sendBtn) sendBtn.disabled = true;
    isAiGenerating = true;

    try {
      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          portfolioId,
          prompt: promptText,
          history: chatHistory,
          model,
          provider
        })
      });

      const data = await res.json();
      removeThinkingIndicator();

      if (!data.success || !data.response) {
        appendModelMessage(`⚠️ **Impossibile completare l'analisi con ${escapeHtml(modelDisplayName)}:**\n\n${data.error || 'Errore di connessione o chiave API non valida.'}\n\n*Puoi verificare o aggiornare le tue chiavi API (Google Gemini, OpenRouter, NVIDIA Nemotron, OpenAI) nella pagina [Impostazioni > Chiavi API](/settings#ai).*`, { model: 'Errore' });
        return;
      }

      // Append model response
      appendModelMessage(data.response, { model: data.model || model });

      // Save turns in session history
      chatHistory.push({ role: 'user', content: promptText });
      chatHistory.push({ role: 'model', content: data.response });

      // Auto-refresh reports archive and counter
      loadSavedReportsCount();
      if (typeof refreshActiveReportsList === 'function') {
        refreshActiveReportsList();
      }

    } catch (err) {
      removeThinkingIndicator();
      appendModelMessage(`⚠️ **Errore di rete:** ${err.message}`, { model: 'Errore' });
    } finally {
      if (sendBtn) sendBtn.disabled = false;
      isAiGenerating = false;
    }
  }

  function resetChatHistory() {
    chatHistory.length = 0;
    const thread = document.getElementById('aiChatThread');
    if (thread) {
      thread.innerHTML = `
        <div id="chatWelcomeBanner" class="p-4 rounded-xl bg-white dark:bg-[#18181b] border border-gray-200/60 dark:border-white/5 space-y-2 text-xs">
          <div class="flex items-center space-x-2 text-emerald-600 dark:text-emerald-400 font-bold">
            <span>✦</span>
            <span>Conversazione azzerata. Assistente Gemini Pro pronto</span>
          </div>
          <p class="text-gray-600 dark:text-gray-300 leading-relaxed">
            Scrivi una nuova richiesta o seleziona un suggerimento in alto per analizzare i tuoi investimenti con dati di portafoglio aggiornati in tempo reale.
          </p>
        </div>
      `;
    }
  }

  // ==========================================
  // AI REPORTS ARCHIVE & CHRONOLOGICAL HISTORY
  // ==========================================
  let cachedReportsList = [];
  let currentViewedReport = null;

  function formatReportDate(dateStr) {
    if (!dateStr) return '-';
    try {
      const d = new Date(dateStr.replace(' ', 'T'));
      if (isNaN(d.getTime())) return dateStr;
      return d.toLocaleDateString('it-IT', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch (_) {
      return dateStr;
    }
  }

  function getReportTypeBadge(type, title) {
    const t = type || 'CHAT_ADVISOR';
    if (t === 'REPORT_SETTIMANALE') {
      return '<span class="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300 border border-emerald-500/20">📰 Settimanale</span>';
    }
    if (t === 'SCORECARD_QUANTITATIVA') {
      return '<span class="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-blue-100 text-blue-800 dark:bg-blue-950/40 dark:text-blue-300 border border-blue-500/20">📊 Scorecard</span>';
    }
    if (t === 'RISCHIO_CONCENTRAZIONE') {
      return '<span class="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300 border border-amber-500/20">🎯 Rischio</span>';
    }
    if (t === 'RIBILANCIAMENTO') {
      return '<span class="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-purple-100 text-purple-800 dark:bg-purple-950/40 dark:text-purple-300 border border-purple-500/20">⚖️ Ribilanciamento</span>';
    }
    if (t === 'STRESS_TEST') {
      return '<span class="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-rose-100 text-rose-800 dark:bg-rose-950/40 dark:text-rose-300 border border-rose-500/20">📉 Stress Test</span>';
    }
    if (t === 'EFFICIENZA_FISCALE') {
      return '<span class="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-teal-100 text-teal-800 dark:bg-teal-950/40 dark:text-teal-300 border border-teal-500/20">💰 Fiscale</span>';
    }
    return '<span class="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-gray-100 text-gray-700 dark:bg-white/10 dark:text-gray-300 border border-gray-200 dark:border-white/10">💬 Chat Advisor</span>';
  }

  async function fetchAiReports(portfolioId = null) {
    try {
      const url = portfolioId && portfolioId !== 'all'
        ? `/api/ai/reports?portfolioId=${encodeURIComponent(portfolioId)}`
        : '/api/ai/reports';
      const res = await fetch(url);
      const data = await res.json();
      if (data.success && Array.isArray(data.reports)) {
        cachedReportsList = data.reports;
        return data.reports;
      }
      return [];
    } catch (e) {
      console.warn('Errore fetchAiReports:', e);
      return [];
    }
  }

  async function loadSavedReportsCount() {
    try {
      const reports = await fetchAiReports();
      const count = reports.length;
      document.querySelectorAll('#savedReportsCount, #savedAiReportsCountReportsPage, #mSavedAiReportsCount, .savedReportsCountBadge').forEach(el => {
        el.textContent = String(count);
      });
      return count;
    } catch (_) {
      return 0;
    }
  }

  function renderAiReportsTable(container, reports, isMobile = false) {
    if (!container) return;
    if (!reports || reports.length === 0) {
      container.innerHTML = `
        <div class="p-8 text-center space-y-2">
          <div class="text-3xl">📜</div>
          <div class="text-sm font-bold text-gray-900 dark:text-white">Nessun report IA archiviato</div>
          <p class="text-xs font-mono text-gray-400 max-w-sm mx-auto">
            I report settimanali e le analisi generate con l'AI Advisor verranno salvati automaticamente qui in ordine cronologico con data/ora, tipo di analisi e modello LLM utilizzato.
          </p>
        </div>
      `;
      return;
    }

    if (isMobile) {
      container.innerHTML = `
        <div class="space-y-2.5">
          ${reports.map(r => `
            <div class="signature-card p-3 space-y-2 border border-gray-200/80 dark:border-white/10">
              <div class="flex items-center justify-between">
                ${getReportTypeBadge(r.report_type, r.report_title)}
                <span class="text-[10px] font-mono text-gray-400">${formatReportDate(r.created_at)}</span>
              </div>
              <div>
                <h4 class="text-xs font-bold text-gray-900 dark:text-white line-clamp-1">${escapeHtml(r.report_title)}</h4>
                <p class="text-[10px] font-mono text-gray-500 line-clamp-2 mt-0.5">${escapeHtml(r.prompt || r.preview || '')}</p>
              </div>
              <div class="flex items-center justify-between pt-1 border-t border-gray-100 dark:border-white/5 text-[10px] font-mono">
                <span class="text-gray-400 truncate max-w-[150px]">🤖 ${escapeHtml(r.model)}</span>
                <div class="flex items-center space-x-1 shrink-0">
                  <button type="button" class="btn-view-report px-2.5 py-1 rounded-lg bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300 font-bold transition hover:bg-emerald-100" data-report-id="${r.id}">
                    Vedi
                  </button>
                  <button type="button" class="btn-delete-report p-1 rounded-lg text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 transition" data-report-id="${r.id}" title="Elimina">
                    <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                  </button>
                </div>
              </div>
            </div>
          `).join('')}
        </div>
      `;
    } else {
      container.innerHTML = `
        <div class="overflow-x-auto">
          <table class="min-w-full text-xs text-left divide-y divide-gray-200 dark:divide-white/10">
            <thead class="bg-gray-50/70 dark:bg-white/[0.02] text-[10px] font-mono text-gray-500 uppercase">
              <tr>
                <th class="px-4 py-3">Data / Ora</th>
                <th class="px-4 py-3">Tipo di Analisi</th>
                <th class="px-4 py-3">Titolo & Richiesta</th>
                <th class="px-4 py-3">Modello LLM</th>
                <th class="px-4 py-3">Portafoglio</th>
                <th class="px-4 py-3 text-right">Azioni</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-100 dark:divide-white/5 font-mono">
              ${reports.map(r => `
                <tr class="hover:bg-gray-50/60 dark:hover:bg-white/[0.02] transition">
                  <td class="px-4 py-3 whitespace-nowrap text-gray-700 dark:text-gray-300">
                    ${formatReportDate(r.created_at)}
                  </td>
                  <td class="px-4 py-3 whitespace-nowrap">
                    ${getReportTypeBadge(r.report_type, r.report_title)}
                  </td>
                  <td class="px-4 py-3 max-w-xs">
                    <div class="font-bold text-gray-900 dark:text-white truncate">${escapeHtml(r.report_title)}</div>
                    <div class="text-[10px] text-gray-400 truncate">${escapeHtml(r.prompt || r.preview || '')}</div>
                  </td>
                  <td class="px-4 py-3 whitespace-nowrap">
                    <span class="px-2 py-0.5 rounded text-[10px] bg-gray-100 dark:bg-white/10 text-gray-800 dark:text-gray-200">
                      ${escapeHtml(r.model)}
                    </span>
                  </td>
                  <td class="px-4 py-3 whitespace-nowrap text-gray-600 dark:text-gray-400 text-[11px]">
                    ${escapeHtml(r.portfolio_name || 'Tutti')}
                  </td>
                  <td class="px-4 py-3 whitespace-nowrap text-right space-x-1">
                    <button type="button" class="btn-view-report btn-pill px-2.5 py-1 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-900/40 text-[11px] font-bold transition inline-flex items-center space-x-1 cursor-pointer" data-report-id="${r.id}">
                      <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>
                      <span>Rivedi</span>
                    </button>
                    <button type="button" class="btn-delete-report btn-pill px-2 py-1 text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 text-[11px] transition inline-flex items-center cursor-pointer" data-report-id="${r.id}" title="Elimina report">
                      <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                    </button>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;
    }

    // Attach listeners
    container.querySelectorAll('.btn-view-report').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-report-id');
        if (id) openAiReportViewer(id);
      });
    });

    container.querySelectorAll('.btn-delete-report').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-report-id');
        if (id) deleteAiReport(id);
      });
    });
  }

  async function openAiReportViewer(reportId) {
    try {
      const res = await fetch(`/api/ai/reports/${reportId}`);
      const data = await res.json();
      if (!data.success || !data.report) {
        alert(data.error || 'Impossibile caricare il report.');
        return;
      }

      currentViewedReport = data.report;
      const r = data.report;

      const modal = document.getElementById('aiReportViewerModal');
      if (!modal) {
        console.warn('aiReportViewerModal non presente nel DOM');
        return;
      }

      const titleEl = document.getElementById('viewerReportTitle');
      const dateEl = document.getElementById('viewerReportDate');
      const modelEl = document.getElementById('viewerReportModel');
      const portEl = document.getElementById('viewerReportPortfolio');
      const typeEl = document.getElementById('viewerReportTypeBadge');
      const promptEl = document.getElementById('viewerReportPrompt');
      const contentEl = document.getElementById('viewerReportContent');

      if (titleEl) titleEl.textContent = r.report_title || 'Report IA';
      if (dateEl) dateEl.textContent = formatReportDate(r.created_at);
      if (modelEl) modelEl.textContent = `${r.model} (${r.provider})`;
      if (portEl) portEl.textContent = r.portfolio_name || 'Tutti i portafogli';
      if (typeEl) typeEl.innerHTML = getReportTypeBadge(r.report_type, r.report_title);
      if (promptEl) promptEl.textContent = r.prompt || '';
      if (contentEl) contentEl.innerHTML = renderMarkdown(r.content || '');

      modal.classList.remove('hidden');
    } catch (err) {
      alert('Errore caricamento report: ' + err.message);
    }
  }

  async function deleteAiReport(reportId) {
    if (!confirm('Sei sicuro di voler eliminare definitivamente questo report dall\'archivio?')) {
      return;
    }

    try {
      const res = await fetch(`/api/ai/reports/${reportId}`, { method: 'DELETE' });
      const data = await res.json();
      if (!data.success) {
        alert(data.error || 'Errore eliminazione report.');
        return;
      }

      // Close modal if deleted report was currently open
      const modal = document.getElementById('aiReportViewerModal');
      if (modal && currentViewedReport && String(currentViewedReport.id) === String(reportId)) {
        modal.classList.add('hidden');
        currentViewedReport = null;
      }

      await loadSavedReportsCount();
      await refreshActiveReportsList();
    } catch (err) {
      alert('Errore eliminazione: ' + err.message);
    }
  }

  async function refreshActiveReportsList() {
    const isMobile = window.innerWidth < 768 || !!document.getElementById('mobileArchiveReportsList');
    const container = document.getElementById('archiveReportsListContainer') || document.getElementById('mobileArchiveReportsList');
    if (container) {
      const pSel = document.getElementById('reportPortfolioSelect')?.value || 'all';
      const reports = await fetchAiReports(pSel);
      renderAiReportsTable(container, reports, isMobile);
    }

    // Also update reports page container if present
    const reportsPageContainer = document.getElementById('aiReportsContainerReportsPage');
    if (reportsPageContainer) {
      const pSel = document.getElementById('portfolioSelect')?.value || 'all';
      const reports = await fetchAiReports(pSel);
      renderAiReportsTable(reportsPageContainer, reports, false);
    }

    // Also update mobile reports page container if present
    const mReportsPageContainer = document.getElementById('mAiReportsContainer');
    if (mReportsPageContainer) {
      const pSel = document.getElementById('mobilePortfolioSelect')?.value || 'all';
      const reports = await fetchAiReports(pSel);
      renderAiReportsTable(mReportsPageContainer, reports, true);
    }
  }

  function initArchiveModalHandlers() {
    const archiveModal = document.getElementById('aiReportsArchiveModal');
    const openArchiveBtn = document.getElementById('btnOpenReportsArchive');
    const closeArchiveBtn = document.getElementById('btnCloseArchiveModal');
    const refreshArchiveBtn = document.getElementById('btnRefreshArchive');

    const showArchive = async () => {
      if (!archiveModal) return;
      archiveModal.classList.remove('hidden');
      await refreshActiveReportsList();
    };

    const hideArchive = () => {
      if (!archiveModal) return;
      archiveModal.classList.add('hidden');
    };

    openArchiveBtn?.addEventListener('click', showArchive);
    closeArchiveBtn?.addEventListener('click', hideArchive);
    refreshArchiveBtn?.addEventListener('click', refreshActiveReportsList);
    archiveModal?.addEventListener('click', (e) => {
      if (e.target === archiveModal) hideArchive();
    });

    // Viewer Modal Handlers
    const viewerModal = document.getElementById('aiReportViewerModal');
    const closeViewerTop = document.getElementById('viewerCloseBtnTop');
    const closeViewerBottom = document.getElementById('viewerCloseBtn');
    const copyViewerBtn = document.getElementById('viewerCopyBtn');
    const deleteViewerBtn = document.getElementById('viewerDeleteBtn');
    const printViewerBtn = document.getElementById('viewerPrintBtn');

    const hideViewer = () => {
      if (!viewerModal) return;
      viewerModal.classList.add('hidden');
    };

    closeViewerTop?.addEventListener('click', hideViewer);
    closeViewerBottom?.addEventListener('click', hideViewer);
    viewerModal?.addEventListener('click', (e) => {
      if (e.target === viewerModal) hideViewer();
    });

    copyViewerBtn?.addEventListener('click', () => {
      if (!currentViewedReport?.content) return;
      navigator.clipboard.writeText(currentViewedReport.content).then(() => {
        const span = copyViewerBtn.querySelector('span:last-child') || copyViewerBtn;
        const orig = span.textContent;
        span.textContent = 'Copiato!';
        setTimeout(() => { span.textContent = orig; }, 2000);
      });
    });

    deleteViewerBtn?.addEventListener('click', () => {
      if (currentViewedReport?.id) {
        deleteAiReport(currentViewedReport.id);
      }
    });

    printViewerBtn?.addEventListener('click', () => {
      window.print();
    });
  }

  // ==========================================
  // AI KEY CONFIGURATION & MODAL CONTROLLER
  // ==========================================
  function initKeyModal() {
    const modal = document.getElementById('geminiKeyModal');
    const openBtn = document.getElementById('geminiKeyModalBtn');

    if (!modal) {
      if (openBtn && openBtn.tagName !== 'A') {
        openBtn.addEventListener('click', () => {
          window.location.href = '/settings#ai';
        });
      }
      return;
    }

    const closeBtn = document.getElementById('btnCloseKeyModal');
    const cancelBtn = document.getElementById('btnCancelKeyModal');
    const saveBtn = document.getElementById('btnSaveKeyModal');
    const toggleVisBtn = document.getElementById('toggleApiKeyVisibility');
    const input = document.getElementById('modalGeminiApiKeyInput');

    const showModal = () => {
      if (!modal) return;
      modal.classList.remove('hidden');
      if (input) input.focus();
    };

    const hideModal = () => {
      if (!modal) return;
      modal.classList.add('hidden');
    };

    openBtn?.addEventListener('click', showModal);
    closeBtn?.addEventListener('click', hideModal);
    cancelBtn?.addEventListener('click', hideModal);

    modal?.addEventListener('click', (e) => {
      if (e.target === modal) hideModal();
    });

    toggleVisBtn?.addEventListener('click', () => {
      if (!input) return;
      input.type = input.type === 'password' ? 'text' : 'password';
    });

    saveBtn?.addEventListener('click', async () => {
      const key = input?.value?.trim();
      if (!key) {
        alert('Inserisci una chiave API Gemini valida (inizia solitamente con AIzaSy...).');
        return;
      }

      saveBtn.disabled = true;
      saveBtn.textContent = 'Salvataggio...';

      try {
        const res = await fetch('/api/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ gemini_api_key: key })
        });
        const data = await res.json();
        if (data.success) {
          hideModal();
          await checkGeminiStatus();
          alert('Google Gemini API Key salvata con successo e cifrata sul database.');
        } else {
          alert('Errore salvataggio: ' + (data.error || 'Riprova.'));
        }
      } catch (err) {
        alert('Errore di comunicazione: ' + err.message);
      } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Salva Chiave';
      }
    });
  }

  // ==========================================
  // INITIALIZATION
  // ==========================================
  document.addEventListener('DOMContentLoaded', async () => {
    if (document.getElementById('goalCurrentAge')) {
      await loadSavedGoals();
    }

    document.getElementById('runSimulationBtn')?.addEventListener('click', runSimulation);
    document.getElementById('runAiBtn')?.addEventListener('click', runAiAnalysis);

    document.getElementById('saveGoalsBtn')?.addEventListener('click', async () => {
      const currentAge = parseInt(document.getElementById('goalCurrentAge')?.value, 10);
      const retirementAge = parseInt(document.getElementById('goalRetirementAge')?.value, 10);
      const monthlySavings = parseFloat(document.getElementById('goalMonthlySavings')?.value);
      const monthlyExpenses = parseFloat(document.getElementById('goalMonthlyExpenses')?.value);
      const expectedReturn = (parseFloat(document.getElementById('goalExpectedReturn')?.value) || 7) / 100;
      const volatility = (parseFloat(document.getElementById('goalVolatility')?.value) || 14) / 100;

      await fetch('/api/goals/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentAge, retirementAge, monthlySavings, monthlyExpenses, expectedReturn, volatility })
      });
      alert('Parametri previdenziali salvati con successo.');
    });

    if (document.getElementById('runSimulationBtn')) {
      setTimeout(runSimulation, 400);
    }

    // Interactive Chat Handlers
    document.getElementById('btnSendPrompt')?.addEventListener('click', () => sendAiChatPrompt());

    const promptInput = document.getElementById('aiPromptInput');
    if (promptInput) {
      promptInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendAiChatPrompt();
        }
      });

      // Auto-resize textarea
      promptInput.addEventListener('input', () => {
        promptInput.style.height = 'auto';
        promptInput.style.height = Math.min(promptInput.scrollHeight, 140) + 'px';
      });
    }

    // Prompt Chips (Quick Suggestions + User Custom Saved)
    initPromptChipsLogic();

    // Reset Chat
    document.getElementById('btnResetChat')?.addEventListener('click', resetChatHistory);

    // Save model choice
    document.getElementById('chatModelSelect')?.addEventListener('change', (e) => {
      localStorage.setItem('foliotrack_ai_chat_model', e.target.value);
      updateSendButtonLabel();
    });

    // Key Modal
    initKeyModal();

    // Archive Modal & Viewer Handlers
    initArchiveModalHandlers();
    loadSavedReportsCount();

    // Check Gemini API Status
    await checkGeminiStatus();
    updateSendButtonLabel();
    updateAiChatPortfolioLabel();

    // Auto-trigger weekly report if passed in URL query (?prompt=weekly-report)
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('prompt') === 'weekly-report') {
      const weeklyBtn = document.querySelector('.weekly-report-chip');
      if (weeklyBtn) {
        setTimeout(() => weeklyBtn.click(), 200);
      }
    }
  });

  window.updateAiChatPortfolioLabel = updateAiChatPortfolioLabel;

  window.AiReportsController = {
    runSimulation,
    runAiAnalysis,
    sendAiChatPrompt,
    resetChatHistory,
    renderMarkdown,
    fetchAiReports,
    loadSavedReportsCount,
    renderAiReportsTable,
    openAiReportViewer,
    deleteAiReport,
    refreshActiveReportsList,
    getLastSimulation: () => lastSimulationData,
    getLastAiAnalysis: () => lastAiAnalysisData
  };
})();
