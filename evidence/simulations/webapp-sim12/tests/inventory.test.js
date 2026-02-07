const { updateStock } = require('../src/InventoryManager');

describe('InventoryManager Core (TDD)', () => {
    it('should update stock correctly for valid change', () => {
        expect(updateStock(10, -5)).toBe(5);
    });

    it('should throw error if resulting stock is negative', () => {
        expect(() => updateStock(10, -11)).toThrow('Insufficient stock');
    });

    it('should allow stock to be exactly zero', () => {
        expect(updateStock(10, -10)).toBe(0);
    });
});
