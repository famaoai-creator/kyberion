import { WalletManager } from './lib.js';
import { runSkill } from '@agent/core';

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

async function main() {
  const args = await yargs(hideBin(process.argv)).argv;
  const wallet = new WalletManager();
  
  if (args.action === 'balance') {
    return { status: 'success', data: wallet.getBalance() };
  }
  
  if (args.action === 'deposit' && args.amount) {
    const tx = wallet.deposit(Number(args.amount), (args.reason as string) || 'Manual deposit');
    return { status: 'success', data: { transaction: tx, balance: wallet.getBalance() } };
  }

  if (args.action === 'withdraw' && args.amount) {
    try {
      const tx = wallet.withdraw(Number(args.amount), (args.reason as string) || 'Manual withdrawal');
      return { status: 'success', data: { transaction: tx, balance: wallet.getBalance() } };
    } catch (e: any) {
      return { status: 'error', error: e.message };
    }
  }

  return { status: 'error', error: 'Unknown or incomplete action. Use balance, deposit, or withdraw.' };
}

runSkill('wallet-manager', main);
