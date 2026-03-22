import assert from 'node:assert/strict';
import test from 'node:test';

import { buildApprovalCard, buildFailureCard } from '../src/transport/feishu-cards.mjs';

test('approval card uses legacy interactive layout with action buttons', () => {
  const card = buildApprovalCard({
    approvalId: 'approval-1',
    runnerName: 'Claude SDK',
    sessionId: 'sess-1',
    command: 'npm test',
    description: 'Run test suite',
    kind: 'tool',
  });

  assert.equal(card.schema, undefined);
  assert.ok(Array.isArray(card.elements));
  const action = card.elements.find((element) => element.tag === 'action');
  assert.ok(action);
  assert.equal(action.actions.length, 3);
  assert.deepEqual(action.actions.map((item) => item.value?.decision), [
    'approve_once',
    'approve_always',
    'reject',
  ]);
});

test('failure card uses schema 2.0 body layout', () => {
  const card = buildFailureCard({
    runnerName: 'Claude SDK',
    reason: 'failed',
    code: '1',
    signal: 'none',
    details: 'boom',
  });

  assert.equal(card.schema, '2.0');
  assert.ok(Array.isArray(card.body?.elements));
  assert.equal(card.body.elements.at(-1)?.tag, 'markdown');
});
