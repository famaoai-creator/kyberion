import { ReasoningBackend, ToolDefinition, GenerateWithToolsResult } from './reasoning-backend.js';
import { logger } from './core.js';
import { a2aBridge } from './a2a-bridge.js';

/**
 * In-Session Reasoning Backend (Prototype)
 * 
 * Instead of spawning a new CLI process for every delegation, this adapter
 * is designed to use Function Calling (Tool Use) to invoke sub-agents
 * within the same memory space / conversation session.
 */
export class InSessionReasoningBackend implements ReasoningBackend {
  private baseBackend: ReasoningBackend;

  constructor(baseBackend: ReasoningBackend) {
    this.baseBackend = baseBackend;
  }

  // Fallback direct prompt to the base backend
  async prompt(prompt: string): Promise<string> {
    return this.baseBackend.prompt(prompt);
  }

  // --- In-Session Delegation Logic ---
  async delegateTask(instruction: string, context?: string): Promise<string> {
    logger.info(`[In-Session] Initiating in-session delegation for task...`);
    
    if (!this.baseBackend.generateWithTools) {
      logger.warn('[In-Session] Base backend does not support generateWithTools. Falling back to native delegateTask.');
      return this.baseBackend.delegateTask(instruction, context);
    }

    const invokeAgentTool: ToolDefinition = {
      name: "invoke_agent",
      description: "Invoke a specialized sub-agent (e.g., 'codebase_investigator', 'generalist') to perform a complex task.",
      inputSchema: {
        type: "object",
        properties: {
          agent_name: { type: "string" },
          prompt: { type: "string", description: "Detailed instruction for the sub-agent" }
        },
        required: ["agent_name", "prompt"]
      }
    };

    const systemPrompt = `
You are a delegating orchestrator. You MUST use the 'invoke_agent' tool to accomplish the following task.
Do NOT attempt to solve it directly.
`.trim();

    const fullPrompt = `${systemPrompt}\n\nTask: ${instruction}\nContext: ${context || 'none'}`;

    try {
      const result = await this.baseBackend.generateWithTools(fullPrompt, [invokeAgentTool]);

      if (result.toolCalls && result.toolCalls.length > 0) {
        const toolCall = result.toolCalls.find(tc => tc.name === 'invoke_agent');
        if (toolCall) {
          const agentName = String(toolCall.input.agent_name || 'generalist');
          const agentPrompt = String(toolCall.input.prompt || instruction);
          
          logger.info(`[In-Session] LLM decided to invoke tool 'invoke_agent' with agent: ${agentName}`);
          const subResult = await this.executeSubAgentInSession(agentName, agentPrompt);
          return `[In-Session Rollup] Sub-agent '${agentName}' completed the task.\nSummary: ${subResult}`;
        }
      }

      return result.text || 'No tool called';
    } catch (err: any) {
      logger.error(`[In-Session] Delegation failed: ${err.message}`);
      throw err;
    }
  }

  /**
   * Executes a sub-agent within the same Node process using the A2A Bridge.
   */
  private async executeSubAgentInSession(agentName: string, prompt: string): Promise<string> {
    logger.info(`[In-Session] Waking up sub-agent: ${agentName} via A2A Bridge...`);
    
    try {
      const response = await a2aBridge.route({
        a2a_version: '1.1',
        header: {
          msg_id: `insession-${Date.now()}`,
          sender: 'orchestrator',
          receiver: agentName,
          performative: 'request'
        },
        payload: {
          content: prompt
        }
      });
      return typeof response.payload === 'object' ? JSON.stringify(response.payload) : String(response.payload || 'Sub-agent returned no data.');
    } catch (err: any) {
      logger.error(`[In-Session] Sub-agent ${agentName} crashed: ${err.message}`);
      throw err;
    }
  }

  async generateWithTools(prompt: string, tools: ToolDefinition[]): Promise<GenerateWithToolsResult> {
    if (this.baseBackend.generateWithTools) {
      return this.baseBackend.generateWithTools(prompt, tools);
    }
    return { text: await this.baseBackend.prompt(prompt) };
  }

  // --- Pass-through methods for compatibility ---
  name = 'insession-prototype';
  
  async extractRequirements(input: any): Promise<any> { throw new Error('Not implemented in prototype'); }
  async extractArchitecture(input: any): Promise<any> { throw new Error('Not implemented in prototype'); }
  async extractTestPlan(input: any): Promise<any> { throw new Error('Not implemented in prototype'); }
  async decomposeIntoTasks(input: any): Promise<any> { throw new Error('Not implemented in prototype'); }
  async divergePersonas(input: any): Promise<any> { throw new Error('Not implemented in prototype'); }
  async crossCritique(input: any): Promise<any> { throw new Error('Not implemented in prototype'); }
  async synthesizePersona(input: any): Promise<any> { throw new Error('Not implemented in prototype'); }
  async generateActionItems(input: any): Promise<any> { throw new Error('Not implemented in prototype'); }
  async refineArtifact(input: any): Promise<any> { throw new Error('Not implemented in prototype'); }
  async extractSystemArchitecture(input: any): Promise<any> { throw new Error('Not implemented in prototype'); }
  async forkBranches(input: any): Promise<any> { throw new Error('Not implemented in prototype'); }
  async simulateBranches(input: any): Promise<any> { throw new Error('Not implemented in prototype'); }
  async extractDesignSpec(input: any): Promise<any> { throw new Error('Not implemented in prototype'); }
}
