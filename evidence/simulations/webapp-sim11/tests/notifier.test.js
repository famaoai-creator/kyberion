const { sendNotification } = require('../src/notifier');

describe('NotificationService (TDD Core)', () => {
  it('should successfully queue a valid notification', () => {
    const result = sendNotification('user1', 'Hello World');
    expect(result.success).toBe(true);
    expect(result.status).toBe('queued');
  });

  it('should fail if message is too long (>100 chars)', () => {
    const longMsg = 'a'.repeat(101);
    const result = sendNotification('user1', longMsg);
    expect(result.success).toBe(false);
    expect(result.error).toBe('Message too long');
  });
});
