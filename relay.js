// Samsung TV Remote Relay Server
// Runs on Fly.io - bridges browser to TV agent
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const AUTH_USER = process.env.AUTH_USER || 'tsqa';
const AUTH_PASS = process.env.AUTH_PASS || 'tsqa';

// Store connected agents (TV-side)
const agents = new Map();
// Store connected browsers waiting for agent
const browsers = new Map();

const server = http.createServer((req, res) => {
  // Basic auth check
  const auth = req.headers['authorization'];
  if (!checkAuth(auth)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Tizen Remote"' });
    res.end('Authentication required');
    return;
  }

  // Serve the HTML remote
  if (req.url === '/' || req.url === '/index.html') {
    const htmlPath = path.join(__dirname, 'Remote Tizen.html');
    if (fs.existsSync(htmlPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(fs.readFileSync(htmlPath));
    } else {
      res.writeHead(404);
      res.end('Remote HTML not found');
    }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

function checkAuth(authHeader) {
  if (!authHeader || !authHeader.startsWith('Basic ')) return false;
  const decoded = Buffer.from(authHeader.slice(6), 'base64').toString();
  const [user, pass] = decoded.split(':', 2);
  return user === AUTH_USER && pass === AUTH_PASS;
}

// WebSocket server
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const type = url.searchParams.get('type'); // 'browser' or 'agent'
  const tvIp = url.searchParams.get('tvIp');
  const sessionId = tvIp || Math.random().toString(36).slice(2);

  if (type === 'agent') {
    // This is a TV agent connecting from user's machine
    console.log(`[${ts()}] Agent connected for TV: ${tvIp}`);
    agents.set(sessionId, ws);

    // If a browser is waiting for this TV
    if (browsers.has(sessionId)) {
      const browser = browsers.get(sessionId);
      console.log(`[${ts()}] Pairing browser with agent for ${tvIp}`);
      pipe(browser, ws, sessionId);
    }

    ws.on('close', () => {
      console.log(`[${ts()}] Agent disconnected: ${tvIp}`);
      agents.delete(sessionId);
    });

  } else {
    // This is a browser connecting
    console.log(`[${ts()}] Browser connected for TV: ${tvIp}`);

    if (agents.has(sessionId)) {
      // Agent already connected - pipe immediately
      const agent = agents.get(sessionId);
      console.log(`[${ts()}] Pairing browser with existing agent for ${tvIp}`);
      pipe(ws, agent, sessionId);
    } else {
      // Wait for agent
      browsers.set(sessionId, ws);
      ws.send(JSON.stringify({
        type: 'waiting',
        message: 'Waiting for local agent... Run: node agent.js'
      }));

      ws.on('close', () => {
        browsers.delete(sessionId);
      });
    }
  }
});

function pipe(browser, agent, sessionId) {
  browser.on('message', (data) => {
    if (agent.readyState === WebSocket.OPEN) {
      agent.send(typeof data === 'string' ? data : data.toString('utf8'));
    }
  });

  agent.on('message', (data) => {
    if (browser.readyState === WebSocket.OPEN) {
      browser.send(typeof data === 'string' ? data : data.toString('utf8'));
    }
  });

  browser.on('close', () => agent.close());
  agent.on('close', () => {
    if (browser.readyState === WebSocket.OPEN) browser.close();
  });
}

function ts() {
  return new Date().toTimeString().slice(0, 8);
}

server.listen(PORT, () => {
  console.log(`Tizen Remote Relay running on port ${PORT}`);
  console.log(`Auth: ${AUTH_USER}/${AUTH_PASS}`);
});
