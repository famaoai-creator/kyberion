import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import * as path from 'node:path';
import { ReflexTerminal } from '../../../libs/core/reflex-terminal.js';
import { logger } from '../../../libs/core/core.js';

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

const staticPath = path.resolve(process.cwd(), 'presence/bridge/terminal/static');
logger.info(`[Terminal] Serving static files from: ${staticPath}`);
app.use(express.static(staticPath));

wss.on('connection', (ws) => {
  logger.info('[Terminal] Client connected via WebSocket');

  try {
    const rt = new ReflexTerminal({
      shell: process.env.SHELL || '/bin/bash',
      cols: 80,
      rows: 30,
      onOutput: (data) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(data);
        }
      }
    });

    // Unified message handler
    ws.on('message', (msg) => {
      try {
        const payload = JSON.parse(msg.toString());
        if (payload.type === 'input' && typeof payload.data === 'string') {
          rt.write(payload.data);
        } else if (payload.type === 'resize' && typeof payload.cols === 'number') {
          rt.resize(payload.cols, payload.rows);
        }
      } catch (err) {
        // Silently ignore or log malformed JSON, but NEVER write raw to PTY
        logger.warn(`[Terminal] Non-JSON input received: ${msg.toString().substring(0, 20)}...`);
      }
    });

    ws.on('close', () => {
      logger.info('[Terminal] Client disconnected');
      rt.kill();
    });

    ws.on('error', (err) => {
      logger.error(`[Terminal] WebSocket error: ${err.message}`);
      rt.kill();
    });

  } catch (err: any) {
    logger.error(`[Terminal] Failed to initialize ReflexTerminal: ${err.message}`);
    ws.send(`\r\n[ERROR] Initialization failed: ${err.message}\r\n`);
    ws.close();
  }
});

const PORT = parseInt(process.env.PORT || '4321', 10);
server.listen(PORT, '0.0.0.0', () => {
  logger.success(`[Terminal] Bridge server running at http://localhost:${PORT}`);
});
