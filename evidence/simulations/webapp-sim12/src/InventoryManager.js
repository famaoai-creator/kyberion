/**
 * 在庫管理コアロジック (ISS)
 */
function updateStock(current, change) {
    const result = current + change;
    if (result < 0) {
        throw new Error('Insufficient stock');
    }
    return result;
}

module.exports = { updateStock };
