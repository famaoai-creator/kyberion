import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { logger, pathResolver, safeReadFile, safeWriteFile } from '@agent/core';

const LEDGER_PATH = pathResolver.rootResolve('knowledge/personal/wallet/ledger.json');

export interface Transaction {
  id: string;
  ts: string;
  type: 'deposit' | 'withdrawal' | 'hold' | 'release';
  amount: number;
  reason: string;
  reference_id?: string;
}

export interface WalletState {
  balance: number;
  held: number;
  currency: string;
  transactions: Transaction[];
  last_updated: string;
}

export class WalletManager {
  private state: WalletState;

  constructor() {
    this.state = this.loadLedger();
  }

  private loadLedger(): WalletState {
    if (fs.existsSync(LEDGER_PATH)) {
      try {
        return JSON.parse(safeReadFile(LEDGER_PATH, { encoding: 'utf8' }) as string);
      } catch (e) {
        logger.error('Failed to parse ledger, initializing new state.');
      }
    }
    return {
      balance: 10000, // Initial Sovereign Grant
      held: 0,
      currency: 'SC', // Sovereign Credits
      transactions: [],
      last_updated: new Date().toISOString()
    };
  }

  private saveLedger() {
    this.state.last_updated = new Date().toISOString();
    safeWriteFile(LEDGER_PATH, JSON.stringify(this.state, null, 2));
  }

  private createTx(type: Transaction['type'], amount: number, reason: string, ref?: string): Transaction {
    return {
      id: `tx-${crypto.randomBytes(4).toString('hex')}`,
      ts: new Date().toISOString(),
      type,
      amount,
      reason,
      reference_id: ref
    };
  }

  public getBalance() {
    return {
      available: this.state.balance - this.state.held,
      total: this.state.balance,
      held: this.state.held,
      currency: this.state.currency
    };
  }

  public deposit(amount: number, reason: string, ref?: string): Transaction {
    if (amount <= 0) throw new Error('Deposit amount must be positive');
    this.state.balance += amount;
    const tx = this.createTx('deposit', amount, reason, ref);
    this.state.transactions.push(tx);
    this.saveLedger();
    return tx;
  }

  public withdraw(amount: number, reason: string, ref?: string): Transaction {
    if (amount <= 0) throw new Error('Withdrawal amount must be positive');
    const available = this.state.balance - this.state.held;
    if (available < amount) {
      throw new Error(`Insufficient funds. Available: ${available} ${this.state.currency}`);
    }
    this.state.balance -= amount;
    const tx = this.createTx('withdrawal', amount, reason, ref);
    this.state.transactions.push(tx);
    this.saveLedger();
    return tx;
  }

  public hold(amount: number, reason: string, ref?: string): Transaction {
    if (amount <= 0) throw new Error('Hold amount must be positive');
    const available = this.state.balance - this.state.held;
    if (available < amount) {
      throw new Error(`Insufficient funds for hold. Available: ${available} ${this.state.currency}`);
    }
    this.state.held += amount;
    const tx = this.createTx('hold', amount, reason, ref);
    this.state.transactions.push(tx);
    this.saveLedger();
    return tx;
  }
}
