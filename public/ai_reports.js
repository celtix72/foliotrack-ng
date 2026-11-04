/**
 * FolioTrack AI Reports & Monte Carlo Frontend Controller
 */

(function () {
  let monteCarloChart = null;
  let lastSimulationData = null;
  let lastAiAnalysisData = null;

  const fmtEur = (v) => '€ ' + (Number(v) || 0).toLocaleString('it-IT', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  const fmtPct = (v) => (Number(v) || 0).toFixed(1) + '%';

  async function loadSavedGoals() {
    try {
      const res = await fetch('/api/goals/saved');
      const data = await res.json();
      if (data.success && data.params) {
        const p = data.params;
        if (p.currentAge) document.getElementById('goalCurrentAge').value = p.currentAge;
        if (p.retirementAge) document.getElementById('goalRetirementAge').value = p.retirementAge;
        if (p.monthlySavings !== undefined) document.getElementById('goalMonthlySavings').value = p.monthlySavings;
        if (p.monthlyExpenses !== undefined) document.getElementById('goalMonthlyExpenses').value = p.monthlyExpenses;
        if (p.expectedReturn !== undefined) document.getElementById('goalExpectedReturn').value = (p.expectedReturn * 100).toFixed(1);
        if (p.volatility !== undefined) document.getElementById('goalVolatility').value = (p.volatility * 100).toFixed(1);
      }
    } catch (err) {
      console.warn('Error loading saved goals:', err);
    }
  }

  async function runSimulation() {
    const portfolioId = document.getElementById('reportPortfolioSelect').value;
    const currentAge = parseInt(document.getElementById('goalCurrentAge').value, 10);
    const retirementAge = parseInt(document.getElementById('goalRetirementAge').value, 10);
    const monthlySavings = parseFloat(document.getElementById('goalMonthlySavings').value) || 0;
    const monthlyExpenses = parseFloat(document.getElementById('goalMonthlyExpenses').value) || 0;
    const expectedReturn = (parseFloat(document.getElementById('goalExpectedReturn').value) || 7.0) / 100.0;
    const volatility = (parseFloat(document.getElementById('goalVolatility').value) || 14.0) / 100.0;

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
    runBtn.disabled = true;
    runBtn.textContent = 'Simulazione in corso...';

    try {
      const res = await fetch('/api/goals/simulate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const data = await res.json();
      if (!data.success) {
        alert(data.error || 'Errore durante la simulazione.');
        return;
      }

      lastSimulationData = data;
      renderSimulationResults(data);
    } catch (err) {
      alert('Errore di comunicazione: ' + err.message);
    } finally {
      runBtn.disabled = false;
      runBtn.textContent = 'Esegui Simulazione Monte Carlo';
    }
  }

  function renderSimulationResults(data) {
    const m = data.metrics;

    // KPI Cards
    document.getElementById('statSuccessRate').textContent = fmtPct(m.successRate);
    const successEl = document.getElementById('statSuccessRate');
    if (m.successRate >= 85) successEl.className = 'text-2xl font-bold font-mono text-emerald-600 dark:text-emerald-400 tabular-nums';
    else if (m.successRate >= 70) successEl.className = 'text-2xl font-bold font-mono text-amber-500 tabular-nums';
    else successEl.className = 'text-2xl font-bold font-mono text-rose-600 tabular-nums';

    document.getElementById('statFireNumber').textContent = fmtEur(m.fireNumber);
    document.getElementById('statRetirementMedian').textContent = fmtEur(m.wealthAtRetirementMedian);
    document.getElementById('statSorrDepleted').textContent = typeof m.sorrDepletedAge === 'number'
      ? `Esaurimento all'età di ${m.sorrDepletedAge} anni`
      : 'Capitale resiliente (Nessun esaurimento)';

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
    const p90 = percentiles.map(p => p.p90);
    const p50 = percentiles.map(p => p.p50);
    const p10 = percentiles.map(p => p.p10);
    const sorrValues = sorr.map(s => s.wealth);

    if (monteCarloChart) monteCarloChart.destroy();
    const isDark = document.documentElement.classList.contains('dark');

    monteCarloChart = new Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Percentile 90 (Ottimistico)',
            data: p90,
            borderColor: '#10b981',
            borderWidth: 1.5,
            pointRadius: 0,
            fill: false,
            tension: 0.1
          },
          {
            label: 'Percentile 50 (Mediano)',
            data: p50,
            borderColor: '#3b82f6',
            borderWidth: 2.5,
            pointRadius: 0,
            fill: false,
            tension: 0.1
          },
          {
            label: 'Percentile 10 (Pessimistico)',
            data: p10,
            borderColor: '#f59e0b',
            borderWidth: 1.5,
            pointRadius: 0,
            fill: false,
            tension: 0.1
          },
          {
            label: 'Scenario SORR (Crollo -30%)',
            data: sorrValues,
            borderColor: '#ef4444',
            borderWidth: 2,
            borderDash: [5, 5],
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

  async function runAiAnalysis() {
    const portfolioId = document.getElementById('reportPortfolioSelect').value;
    if (portfolioId === 'all') {
      alert('Seleziona un singolo portafoglio specifico per eseguire l\'analisi dettagliata con AI Advisor.');
      return;
    }

    const provider = document.getElementById('aiProviderSelect').value;
    const aiBtn = document.getElementById('runAiBtn');
    aiBtn.disabled = true;
    aiBtn.textContent = 'Analisi in elaborazione...';

    const container = document.getElementById('aiResultsContainer');
    container.classList.remove('hidden');
    document.getElementById('aiLoadingSpinner').classList.remove('hidden');
    document.getElementById('aiAnalysisContent').classList.add('hidden');

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
    } catch (err) {
      alert('Errore di comunicazione: ' + err.message);
    } finally {
      aiBtn.disabled = false;
      aiBtn.textContent = 'Genera Analisi con AI Advisor';
      document.getElementById('aiLoadingSpinner').classList.add('hidden');
    }
  }

  function renderAiResults(a) {
    document.getElementById('aiAnalysisContent').classList.remove('hidden');

    // Model and provider info
    document.getElementById('aiProviderBadge').textContent = `${a.provider} (${a.model || ''})`;

    // Scores
    document.getElementById('aiRiskScore').textContent = `${a.riskScore}/100`;
    document.getElementById('aiDiversificationScore').textContent = `${a.diversificationScore}/100`;
    document.getElementById('aiQualityBadge').textContent = a.assetAllocationQuality || 'Buona';

    // Lists
    const renderList = (items, elementId, bulletClass = 'text-emerald-500') => {
      const ul = document.getElementById(elementId);
      if (!ul) return;
      ul.innerHTML = (items || []).map(item => `
        <li class="flex items-start space-x-2">
          <span class="${bulletClass} font-bold select-none">&bull;</span>
          <span class="text-xs text-gray-700 dark:text-gray-300">${item}</span>
        </li>
      `).join('');
    };

    renderList(a.strengths, 'aiStrengthsList', 'text-emerald-500');
    renderList(a.weaknesses, 'aiWeaknessesList', 'text-amber-500');
    renderList(a.tacticalRecommendations, 'aiTacticalList', 'text-blue-500');
    renderList(a.strategicRecommendations, 'aiStrategicList', 'text-purple-500');

    if (a.marketContextSummary) {
      document.getElementById('aiMarketContext').textContent = a.marketContextSummary;
    }
  }

  document.addEventListener('DOMContentLoaded', async () => {
    await loadSavedGoals();

    document.getElementById('runSimulationBtn')?.addEventListener('click', runSimulation);
    document.getElementById('runAiBtn')?.addEventListener('click', runAiAnalysis);

    document.getElementById('saveGoalsBtn')?.addEventListener('click', async () => {
      const currentAge = parseInt(document.getElementById('goalCurrentAge').value, 10);
      const retirementAge = parseInt(document.getElementById('goalRetirementAge').value, 10);
      const monthlySavings = parseFloat(document.getElementById('goalMonthlySavings').value);
      const monthlyExpenses = parseFloat(document.getElementById('goalMonthlyExpenses').value);
      const expectedReturn = (parseFloat(document.getElementById('goalExpectedReturn').value) || 7) / 100;
      const volatility = (parseFloat(document.getElementById('goalVolatility').value) || 14) / 100;

      await fetch('/api/goals/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentAge, retirementAge, monthlySavings, monthlyExpenses, expectedReturn, volatility })
      });
      alert('Parametri previdenziali salvati con successo.');
    });

    // Auto run first simulation
    setTimeout(runSimulation, 400);
  });

  window.AiReportsController = {
    runSimulation,
    runAiAnalysis,
    getLastSimulation: () => lastSimulationData,
    getLastAiAnalysis: () => lastAiAnalysisData
  };
})();

