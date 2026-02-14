const { safeWriteFile } = require('@agent/core/secure-io');
const _fs = require('fs');
const path = require('path');
const { logger } = require('@agent/core/core');
const { runSkill } = require('@agent/core');

// Simulating session data for demonstration.
// In a real scenario, this would read from `knowledge/personal/biometrics/session_logs.json`.
const mockSessions = [
  { date: '2026-02-01', mood: 'Flow', icon: '😄', note: 'High velocity coding' },
  { date: '2026-02-02', mood: 'Normal', icon: '🙂', note: 'Routine maintenance' },
  { date: '2026-02-03', mood: 'Stressed', icon: '😫', note: 'High typo rate detected' },
  { date: '2026-02-04', mood: 'Flow', icon: '😄', note: 'Strategy planning' },
  { date: '2026-02-05', mood: 'Fatigued', icon: '😴', note: 'Late night session' },
  { date: '2026-02-06', mood: 'Normal', icon: '🙂', note: 'Documentation' },
  { date: '2026-02-07', mood: 'Flow', icon: '😄', note: 'System upgrade' },
];

runSkill('biometric-context-adapter', () => {
  const reportPath = path.resolve(__dirname, '../../work/niko_niko_calendar.md');

  let markdown = `# 📅 Niko-Niko Calendar (Biometric Feedback)

Analysis of your interaction patterns to visualize energy and stress levels.

| Date | Mood | State | Insights |
| :--- | :---: | :--- | :--- |
`;

  mockSessions.forEach((session) => {
    markdown += `| ${session.date} | ${session.icon} | **${session.mood}** | ${session.note} |\n`;
  });

  markdown += `
## 💡 Agent's Observation
- **Trend**: You operate best in "Flow" when working on Strategy and Core Systems.
- **Warning**: "Fatigue" detected after consecutive late-night sessions. Consider enabling 'Brief Mode' tonight.
`;

  safeWriteFile(reportPath, markdown);
  logger.success(`Niko-Niko Calendar generated at: ${reportPath}`);

  return { output: reportPath, sessions: mockSessions.length };
});
