export interface Session {
  date: string;
  mood: string;
  icon: string;
  note: string;
}

export function generateNikoNikoMarkdown(sessions: Session[]): string {
  const nl = String.fromCharCode(10);
  let markdown = '# 📅 Niko-Niko Calendar (Biometric Feedback)' + nl + nl;
  markdown += 'Analysis of your interaction patterns.' + nl + nl;
  markdown += '| Date | Mood | State | Insights |' + nl;
  markdown += '| :--- | :---: | :--- | :--- |' + nl;

  sessions.forEach((session) => {
    markdown +=
      '| ' +
      session.date +
      ' | ' +
      session.icon +
      ' | **' +
      session.mood +
      '** | ' +
      session.note +
      ' |' +
      nl;
  });

  markdown += nl + "## 💡 Agent's Observation" + nl;
  markdown += "- **Trend**: Operating well in 'Flow'." + nl;
  return markdown;
}
