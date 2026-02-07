/**
 * ユーザー通知配信コアロジック
 */
function sendNotification(userId, message) {
  if (!message || message.length > 100) {
    return { success: false, error: 'Message too long' };
  }
  
  // 本来はここでキューイング処理を行う
  return { success: true, status: 'queued', userId };
}

module.exports = { sendNotification };
