/**
 * Retirement & FIRE Quantitative Engine for FolioTrack
 * Monte Carlo stochastic simulation (1000 iterations), SORR (Sequence of Returns Risk) analysis,
 * and 4% Rule / FIRE Number calculations.
 */

/**
 * Standard Normal Random Variable Generator using Box-Muller transform.
 * @returns {number}
 */
function randomNormal(mean = 0, stdDev = 1) {
  let u1 = 0;
  let u2 = 0;
  while (u1 === 0) u1 = Math.random();
  while (u2 === 0) u2 = Math.random();
  const z = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  return mean + z * stdDev;
}

/**
 * Calculates quantile / percentile from a sorted array of numbers.
 *
 * @param {number[]} sortedArr
 * @param {number} p Value between 0 and 1 (e.g. 0.1 for 10th percentile)
 * @returns {number}
 */
function quantile(sortedArr, p) {
  if (sortedArr.length === 0) return 0;
  if (p <= 0) return sortedArr[0];
  if (p >= 1) return sortedArr[sortedArr.length - 1];

  const index = (sortedArr.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;

  if (lower === upper) return sortedArr[lower];
  return sortedArr[lower] * (1 - weight) + sortedArr[upper] * weight;
}

/**
 * Runs a 1000-iteration Monte Carlo simulation for retirement & FIRE planning.
 *
 * @param {object} params
 * @param {number} [params.currentAge=35] Current age of investor
 * @param {number} [params.retirementAge=60] Target retirement age
 * @param {number} [params.lifeExpectancy=85] Horizon / life expectancy
 * @param {number} [params.currentWealth=50000] Initial wealth in EUR
 * @param {number} [params.monthlySavings=500] Monthly savings during accumulation
 * @param {number} [params.monthlyExpenses=2000] Expected monthly living costs in retirement
 * @param {number} [params.expectedReturn=0.07] Nominal expected annual return (e.g. 7%)
 * @param {number} [params.volatility=0.14] Annual standard deviation of portfolio (e.g. 14%)
 * @param {number} [params.inflationRate=0.02] Annual inflation rate (e.g. 2%)
 * @param {number} [params.iterations=1000] Number of stochastic runs
 * @returns {object} Monte Carlo and SORR projection results
 */
function runMonteCarloRetirement({
  currentAge = 35,
  retirementAge = 60,
  lifeExpectancy = 85,
  currentWealth = 50000,
  monthlySavings = 500,
  monthlyExpenses = 2000,
  expectedReturn = 0.07,
  volatility = 0.14,
  inflationRate = 0.02,
  iterations = 1000
} = {}) {
  const cAge = Math.max(18, parseInt(currentAge, 10) || 35);
  const rAge = Math.max(cAge + 1, parseInt(retirementAge, 10) || 60);
  const lExp = Math.max(rAge + 1, parseInt(lifeExpectancy, 10) || 85);
  const startWealth = Math.max(0, Number(currentWealth) || 0);
  const mSavings = Math.max(0, Number(monthlySavings) || 0);
  const mExpenses = Math.max(0, Number(monthlyExpenses) || 0);
  const mu = Number(expectedReturn) || 0.07;
  const sigma = Math.max(0.01, Number(volatility) || 0.14);
  const infl = Math.max(0.0, Number(inflationRate) || 0.02);
  const numIterations = Math.min(Math.max(parseInt(iterations, 10) || 1000, 100), 5000);

  const totalYears = lExp - cAge;
  const accumulationYears = rAge - cAge;
  const annualSavings = mSavings * 12;
  const initialAnnualExpenses = mExpenses * 12;

  // FIRE Number (Standard 4% safe withdrawal rule: 25x annual expenses)
  const fireNumber = initialAnnualExpenses * 25;

  // Matrix to store capital at each year for all iterations: trajectories[yearIndex][iteration]
  const trajectories = Array.from({ length: totalYears + 1 }, () => new Float64Array(numIterations));

  let successfulIterations = 0;

  for (let it = 0; it < numIterations; it++) {
    let wealth = startWealth;
    trajectories[0][it] = wealth;
    let survived = true;

    for (let yr = 1; yr <= totalYears; yr++) {
      const age = cAge + yr;

      // Lognormal geometric annual return: exp((mu - 0.5 * sigma^2) + sigma * Z) - 1
      const drift = mu - 0.5 * (sigma * sigma);
      const z = randomNormal(0, 1);
      const annualReturn = Math.exp(drift + sigma * z) - 1;

      if (age <= rAge) {
        // Accumulation Phase: growth on wealth + annual savings
        wealth = Math.max(0, wealth * (1 + annualReturn) + annualSavings);
      } else {
        // Decumulation Phase: growth on wealth - inflation-adjusted expenses
        const decumulationYear = age - rAge;
        const adjustedExpenses = initialAnnualExpenses * Math.pow(1 + infl, decumulationYear);

        wealth = wealth * (1 + annualReturn) - adjustedExpenses;
        if (wealth <= 0) {
          wealth = 0;
          survived = false;
        }
      }

      trajectories[yr][it] = wealth;
    }

    if (survived) {
      successfulIterations++;
    }
  }

  // Calculate year-by-year percentiles
  const yearlyPercentiles = [];
  for (let yr = 0; yr <= totalYears; yr++) {
    const age = cAge + yr;
    const isRetirement = age === rAge;
    const phase = age <= rAge ? 'accumulation' : 'decumulation';

    const vals = Array.from(trajectories[yr]).sort((a, b) => a - b);
    yearlyPercentiles.push({
      year: yr,
      age,
      phase,
      isRetirement,
      p10: Math.round(quantile(vals, 0.1)),
      p50: Math.round(quantile(vals, 0.5)),
      p90: Math.round(quantile(vals, 0.9))
    });
  }

  // Sequence of Returns Risk (SORR) Analysis:
  // Simulates deterministic crash of -30% spread across the first 3 retirement years (-18%, -10%, -5%)
  const sorrTrajectory = [];
  let sorrWealth = startWealth;
  sorrTrajectory.push({ age: cAge, wealth: Math.round(sorrWealth) });
  let sorrDepletedAge = null;

  for (let yr = 1; yr <= totalYears; yr++) {
    const age = cAge + yr;

    if (age <= rAge) {
      // Mean return during accumulation
      sorrWealth = Math.max(0, sorrWealth * (1 + mu) + annualSavings);
    } else {
      const retirementYr = age - rAge;
      let returnRate = mu;

      // Apply severe early retirement market shocks
      if (retirementYr === 1) returnRate = -0.18;
      else if (retirementYr === 2) returnRate = -0.10;
      else if (retirementYr === 3) returnRate = -0.05;

      const adjustedExpenses = initialAnnualExpenses * Math.pow(1 + infl, retirementYr);
      sorrWealth = sorrWealth * (1 + returnRate) - adjustedExpenses;

      if (sorrWealth <= 0) {
        sorrWealth = 0;
        if (!sorrDepletedAge) sorrDepletedAge = age;
      }
    }

    sorrTrajectory.push({ age, wealth: Math.round(sorrWealth) });
  }

  const successRate = Math.round((successfulIterations / numIterations) * 1000) / 10;
  const retirementMedian = yearlyPercentiles.find(p => p.age === rAge)?.p50 || 0;

  return {
    params: {
      currentAge: cAge,
      retirementAge: rAge,
      lifeExpectancy: lExp,
      currentWealth: startWealth,
      monthlySavings: mSavings,
      monthlyExpenses: mExpenses,
      expectedReturn: mu,
      volatility: sigma,
      inflationRate: infl,
      iterations: numIterations
    },
    metrics: {
      fireNumber,
      successRate,
      wealthAtRetirementMedian: retirementMedian,
      isFireAchievable: retirementMedian >= fireNumber,
      sorrDepletedAge: sorrDepletedAge || 'Nessun esaurimento (Capitale resiliente)',
      totalYears,
      accumulationYears,
      decumulationYears: lExp - rAge
    },
    percentiles: yearlyPercentiles,
    sorr: sorrTrajectory
  };
}

module.exports = {
  randomNormal,
  quantile,
  runMonteCarloRetirement
};

