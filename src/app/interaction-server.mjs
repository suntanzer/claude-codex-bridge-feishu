import { createServer } from 'node:http';
import { normalizeApprovalDecision } from '../approval/decisions.mjs';
import { buildApprovalCallbackResponse } from '../approval/ui.mjs';

export function startInteractionServer({
  logger,
  approvalStore,
  approvalService,
  onResolvedApproval,
  interactionPath,
  interactionPort,
  interactionListenHost,
  callbackUrl,
}) {
  const maxBodyBytes = 64 * 1024;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost');

      if (req.method === 'GET' && url.pathname === '/health') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ status: 'ok', path: interactionPath }));
        return;
      }

      if (req.method !== 'POST' || url.pathname !== interactionPath) {
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
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const context = payload?.context || {};
      const approvalId = String(context.approval_id || '').trim();
      const approval = approvalStore.get(approvalId);
      const decision = normalizeApprovalDecision(context.decision, approval?.kind || 'tool');

      if (!approval || approval.status !== 'pending' || !decision) {
        logger.warn?.(
          `interaction callback ignored approval=${approvalId || '(none)'} decision=${decision || '(none)'} reason=inactive`,
        );
        res.statusCode = 410;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ephemeral_text: 'This approval request is no longer active.' }));
        return;
      }

      await approvalService.resolveApproval(approvalId, decision, {
        via: 'button',
        userId: payload?.user_id || '',
        userName: payload?.user_name || payload?.user_id || '',
      });
      await onResolvedApproval?.(approval, decision, {
        via: 'button',
        userId: payload?.user_id || '',
        userName: payload?.user_name || payload?.user_id || '',
      });
      logger.info(
        `interaction callback resolved approval=${approvalId} decision=${decision} via=button user=${payload?.user_id || '(unknown)'}`,
      );

      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(buildApprovalCallbackResponse({
        decision,
        userName: payload?.user_name || payload?.user_id || 'unknown',
        kind: approval?.kind || 'tool',
      })));
    } catch (error) {
      logger.error(`interaction callback failed: ${String(error)}`);
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ephemeral_text: 'Interaction handler failed.' }));
    }
  });

  server.listen(interactionPort, interactionListenHost, () => {
    logger.info(
      `mattermost interactions listening on ${interactionListenHost}:${interactionPort} callback=${callbackUrl || '<none>'} path=${interactionPath}`,
    );
  });

  return server;
}
