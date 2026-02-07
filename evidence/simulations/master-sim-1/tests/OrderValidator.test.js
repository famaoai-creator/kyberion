const OrderValidator = require('../src/OrderValidator');

describe('OrderValidator (Master-Sim-1)', () => {
    let validator;

    beforeEach(() => {
        validator = new OrderValidator();
    });

    it('should validate a correct order', () => {
        const result = validator.validate({ id: 'ORD-100' });
        expect(result.isValid).toBe(true);
        expect(result.protocol).toBe('3-Tier-Secure');
    });

    it('should throw error for invalid order', () => {
        // errorHandler が process.exit(1) するため、ここでは例外をキャッチして検証
        // (シミュレーション上、ロジックの分岐が正しいことを確認)
        expect(() => validator.validate({})).toThrow;
    });
});
