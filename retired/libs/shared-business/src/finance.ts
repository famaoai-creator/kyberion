/**
 * Finance & Strategy Utilities.
 */

export const calculateReinvestment = (savedHours: number) => {
  const HOURS_PER_FEATURE = 40;
  const REINVESTMENT_RATIO = 0.7;

  const reinvestableHours = savedHours * REINVESTMENT_RATIO;
  const potentialFeatures = (reinvestableHours / HOURS_PER_FEATURE).toFixed(1);
  const costAvoidanceUSD = savedHours * 100;

  return {
    reinvestableHours: Math.round(reinvestableHours),
    potentialFeatures,
    costAvoidanceUSD,
    recommendation:
      parseFloat(potentialFeatures) >= 1.0
        ? `You have enough saved capacity to develop ${potentialFeatures} new autonomous skills!`
        : 'Focus on cumulative savings to reach the next feature milestone.',
  };
};

export const finance = { calculateReinvestment };
