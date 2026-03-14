import {
  CopilotRuntime,
  CopilotServiceAdapter,
  copilotRuntimeNextJSAppRouterEndpoint,
} from "@copilotkit/runtime";
import { ACPMediator } from "../../../lib/core/acp-mediator";

/**
 * ACPMediatorAdapter
 * Bridges CopilotKit requests to Kyberion's ptyEngine-based ACPMediator using the correct EventSource API.
 */
class ACPMediatorAdapter implements CopilotServiceAdapter {
  private mediator: ACPMediator;

  constructor() {
    this.mediator = new ACPMediator({
      threadId: "chronos-mirror-session",
      bootCommand: "gemini",
      bootArgs: ["--acp", "--approval-mode=yolo"],
      modelId: "gemini-2.5-flash"
    });
  }

  async process(request: any): Promise<any> {
    const { eventSource, messages, threadId, runId } = request;

    // Ensure mediator is booted
    try {
      await this.mediator.boot();
    } catch (e) {
      // Ignore if already booted
    }

    // Extract the prompt
    let prompt = "Hello";
    if (messages && messages.length > 0) {
      const lastMessage = messages[messages.length - 1];
      prompt = typeof lastMessage.content === 'string' 
        ? lastMessage.content 
        : JSON.stringify(lastMessage.content);
    }

    const messageId = `msg-${Date.now()}`;
    
    // Signal start
    eventSource.sendTextMessageStart({ messageId });

    try {
      // Ask Kyberion's Internal Agent
      const responseText = await this.mediator.ask(prompt);
      
      // Stream the content back (for prototype, we send it in one chunk)
      eventSource.sendTextMessageContent({
        messageId,
        content: responseText || "(Agent finished without text)"
      });
      
    } catch (err: any) {
      eventSource.sendTextMessageContent({
        messageId,
        content: `[Error: ${err.message}]`
      });
    }

    // Signal end
    eventSource.sendTextMessageEnd({ messageId });

    return {
      threadId: threadId || "chronos-mirror-session",
      runId: runId || `run-${Date.now()}`
    };
  }
}

const runtime = new CopilotRuntime();
const adapter = new ACPMediatorAdapter();

export const POST = async (req: Request) => {
  const { handleRequest } = copilotRuntimeNextJSAppRouterEndpoint({
    runtime,
    serviceAdapter: adapter as any,
    endpoint: "/api/copilotkit",
  });

  return handleRequest(req);
};
