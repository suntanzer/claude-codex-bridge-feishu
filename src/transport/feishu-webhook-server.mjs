import { createServer } from 'node:http';
import {
  extractFeishuVerificationToken,
  isFeishuUrlVerification,
  unwrapFeishuPayload,
} from './feishu-signature.mjs';

const EVENT_DEDUP_TTL_MS = 5 * 60_000;
const EVENT_DEDUP_MAX_SIZE = 2000;

export function startFeishuWebhookServer({
  logger,
  listenHost,
  port,
  path,
  encryptKey,
  verificationToken,
  onEvent,
}) {
  const maxBodyBytes = 512 * 1024;
  const seenEventIds = new Map();

  function deduplicateEvent(eventId) {
    if (!eventId) return false;
    const now = Date.now();
    if (seenEventIds.has(eventId)) return true;
    seenEventIds.set(eventId, now);
    if (seenEventIds.size > EVENT_DEDUP_MAX_SIZE) {
      for (const [id, ts] of seenEventIds) {
        if (now - ts > EVENT_DEDUP_TTL_MS) seenEventIds.delete(id);
      }
    }
    return false;
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost');

      if (req.method === 'GET' && url.pathname === '/health') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ status: 'ok', path }));
        return;
      }

      if (req.method !== 'POST' || url.pathname !== path) {
        res.statusCode = 404;
        res.end('Not Found');
        return;
      }

      const chunks = [];
      let totalSize = 0;
      for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalSize += buffer.length;
        if (totalSize > maxBodyBytes) {
          res.statusCode = 413;
          res.end('Payload Too Large');
          return;
        }
        chunks.push(buffer);
      }

      let rawPayload;
      try {
        rawPayload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ code: 400, msg: 'malformed JSON' }));
        return;
      }
      const payload = unwrapFeishuPayload(rawPayload, encryptKey);
      const token = extractFeishuVerificationToken(payload);
      const eventType = String(payload?.header?.event_type || '').trim();
      const eventId = String(payload?.header?.event_id || '').trim();
      const payloadType = String(payload?.type || '').trim();
      const remoteAddress = String(req.socket?.remoteAddress || '').trim();
      const userAgent = String(req.headers['user-agent'] || '').trim();

      logger.info(
        `feishu webhook received: remote=${remoteAddress || '-'} ua=${userAgent || '-'} encrypted=${
          rawPayload?.encrypt ? 'yes' : 'no'
        } type=${payloadType || '-'} event=${eventType || '-'}`
      );

      if (verificationToken && (!token || token !== verificationToken)) {
        res.statusCode = 403;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ code: 403, msg: 'invalid verification token' }));
        return;
      }

      if (isFeishuUrlVerification(payload)) {
        logger.info('feishu webhook url_verification accepted');
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ challenge: payload.challenge }));
        return;
      }

      if (deduplicateEvent(eventId)) {
        logger.info(`feishu webhook duplicate event ignored: event_id=${eventId}`);
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ code: 0, msg: 'ok' }));
        return;
      }

      const responseBody = (await onEvent?.(payload)) || { code: 0, msg: 'ok' };
      logger.info(`feishu webhook handled: event=${eventType || '-'} code=${responseBody?.code ?? 0}`);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(responseBody));
    } catch (error) {
      logger.error(`feishu webhook failed: ${String(error)}`);
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ code: 500, msg: 'internal error' }));
    }
  });

  server.listen(port, listenHost, () => {
    logger.info(`feishu callbacks listening on ${listenHost}:${port} path=${path}`);
  });

  return server;
}
