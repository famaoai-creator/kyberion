import { redirect } from 'next/navigation';

// interim until FD-06 merges /setup into /settings
export default function SettingsPage() {
  redirect('/setup');
}
