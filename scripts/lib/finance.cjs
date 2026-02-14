/**
 * Finance & Strategy Utilities.
 * Calculates ROI and Reinvestment Potential.
 */

const finance = {
  /**
   * Calculates how many 'new feature points' can be developed using saved time.
   * @param {number} savedHours 
   * @returns {Object} Reinvestment metrics
   */
  calculateReinvestment: (savedHours) => {
    const HOURS_PER_FEATURE = 40; // 1 week for a small feature
    const REINVESTMENT_RATIO = 0.7; // 70% of saved time can be reinvested
    
    const reinvestableHours = savedHours * REINVESTMENT_RATIO;
    const potentialFeatures = (reinvestableHours / HOURS_PER_FEATURE).toFixed(1);
    const costAvoidanceUSD = savedHours * 100; // Assuming $100/hr

    return {
      reinvestableHours: Math.round(reinvestableHours),
      potentialFeatures,
      costAvoidanceUSD,
      recommendation: potentialFeatures >= 1.0 
        ? `You have enough saved capacity to develop ${potentialFeatures} new autonomous skills!` 
        : "Focus on cumulative savings to reach the next feature milestone."
    };
  }
};

module.exports = finance;
