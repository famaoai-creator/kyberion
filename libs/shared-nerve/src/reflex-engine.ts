/**
 * libs/core/reflex-engine.ts
 * Kyberion Autonomous Nerve System (KANS) - Reflex Engine v1.0
 * [SECURE-IO COMPLIANT]
 * 
 * Evaluates incoming stimuli against Reflex ADFs to trigger autonomic reactions.
 */

import { logger, safeReaddir, safeReadFile, safeExistsSync, pathResolver } from '@agent/core';
import type { NerveMessage } from '@agent/core/nerve-bridge';

export interface ReflexADF {
  id: string;
  trigger: {
    intent: string;
    keyword?: string;
    source?: string;
  };
  action: {
    actuator: string;
    command: string;
    params?: any;
  };
}

type DispatcherFn = (actuator: string, action: string, params: any) => Promise<void>;

class ReflexEngine {
  private reflexes: ReflexADF[] = [];
  private dispatcher?: DispatcherFn;
  private readonly REFLEX_DIR = pathResolver.resolve('knowledge/procedures/reflexes');

  constructor() {
    this.reloadReflexes();
  }

  public setDispatcher(fn: DispatcherFn) {
    this.dispatcher = fn;
  }

  public reloadReflexes() {
    this.reflexes = [];
    if (!safeExistsSync(this.REFLEX_DIR)) return;

    try {
      const files = safeReaddir(this.REFLEX_DIR).filter(f => f.endsWith('.adf.json'));
      for (const file of files) {
        const content = safeReadFile(pathResolver.resolve(`knowledge/procedures/reflexes/${file}`), { encoding: 'utf8' }) as string;
        this.reflexes.push(JSON.parse(content));
      }
      logger.info(`⚡ [ReflexEngine] Loaded ${this.reflexes.length} autonomic reflexes.`);
    } catch (err) {
      logger.error(`Failed to load reflexes: ${err}`);
    }
  }

  /**
   * Evaluate a stimulus against all loaded reflexes.
   */
  public async evaluate(stimulus: NerveMessage) {
    for (const reflex of this.reflexes) {
      if (this.matches(stimulus, reflex.trigger)) {
        logger.warn(`⚡ [REFLEX] Triggered: ${reflex.id} by stimulus ${stimulus.id}`);
        await this.executeReaction(reflex.action, stimulus);
      }
    }
  }

  private matches(stimulus: NerveMessage, trigger: ReflexADF['trigger']): boolean {
    if (stimulus.intent !== trigger.intent) return false;
    if (trigger.source && stimulus.from !== trigger.source) return false;
    
    if (trigger.keyword) {
      const payloadStr = JSON.stringify(stimulus.payload || '');
      if (!payloadStr.includes(trigger.keyword)) return false;
    }
    return true;
  }

  private async executeReaction(action: ReflexADF['action'], stimulus: NerveMessage) {
    if (!this.dispatcher) {
      logger.warn(`⚠️ [REFLEX] Cannot execute ${action.actuator}. No dispatcher bound.`);
      return;
    }

    try {
      // Simple template replacement for payload injection
      let paramsStr = JSON.stringify(action.params || {});
      paramsStr = paramsStr.replace(/\{\{payload\}\}/g, typeof stimulus.payload === 'string' ? stimulus.payload : JSON.stringify(stimulus.payload));
      
      await this.dispatcher(action.actuator, action.command, JSON.parse(paramsStr));
    } catch (err: any) {
      logger.error(`❌ [REFLEX] Reaction failed: ${err.message}`);
    }
  }
}

export const reflexEngine = new ReflexEngine();
