const express = require('express');
const http = require('http');
const https = require('https');

const router = express.Router();

const JAVA_BASE = process.env.BULK_CALENDAR_API_URL || 'http://localhost:8080';

// Proxy all requests under /api/chat-cleaner/* → Java Spring Boot at BULK_CALENDAR_API_URL/api/*
router.all('/*', (req, res) => {
  const targetPath = '/api' + req.path;
  const targetUrl = new URL(targetPath, JAVA_BASE);

  // Forward query params
  Object.entries(req.query).forEach(([k, v]) => targetUrl.searchParams.set(k, v));

  const isSSE = req.headers.accept && req.headers.accept.includes('text/event-stream');
  const lib = targetUrl.protocol === 'https:' ? https : http;

  const options = {
    hostname: targetUrl.hostname,
    port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
    path: targetUrl.pathname + targetUrl.search,
    method: req.method,
    headers: {
      'Content-Type': req.headers['content-type'] || 'application/json',
      ...(isSSE ? { Accept: 'text/event-stream' } : {}),
    },
  };

  const proxyReq = lib.request(options, (proxyRes) => {
    res.statusCode = proxyRes.statusCode;
    Object.entries(proxyRes.headers).forEach(([k, v]) => {
      if (k.toLowerCase() !== 'transfer-encoding') res.setHeader(k, v);
    });
    if (isSSE) {
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();
    }
    proxyRes.pipe(res, { end: true });
  });

  proxyReq.on('error', (err) => {
    if (!res.headersSent) {
      res.status(502).json({ error: 'Chat Cleaner service unavailable. Make sure the Java app is running on port 8080.' });
    }
  });

  if (req.method === 'POST' && req.body) {
    proxyReq.write(JSON.stringify(req.body));
  }

  proxyReq.end();
});

module.exports = router;
