const { logger, errorHandler } = require('../../../../scripts/lib/core.cjs');

/**
 * 保険金請求処理コアロジック (Waterfall Simulation)
 */
class ClaimProcessor {
    validateClaim(policy, accidentDate) {
        try {
            logger.info(`Validating claim for Policy: ${policy.id}`);
            const start = new Date(policy.startDate);
            const end = new Date(policy.endDate);
            const accident = new Date(accidentDate);

            return accident >= start && accident <= end;
        } catch (err) {
            errorHandler(err, 'Claim Validation Failure');
        }
    }

    calculatePayout(baseAmount, hasRider) {
        // 特約がある場合は 20% 増し
        return hasRider ? baseAmount * 1.2 : baseAmount;
    }
}

module.exports = ClaimProcessor;
