import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluatePilotGates } from './evaluate-pilot-gates.mjs';

const passing = {
  pilotStores: 2,
  parallelDays: 30,
  ledgerReconciliationRate: 1,
  taxAmountDifferenceWon: 0,
  duplicateExternalIssues: 0,
  pendingOutbox: 0,
  deadLetters: 0,
  authorizationTestsPassed: true,
  restoreDrillPassed: true,
  mobileTaskSuccessRate: 0.97,
  approvalSlaRate: 0.96,
  unresolvedSeverity1: 0
};

test('returns GO only when every pilot gate passes', () => {
  assert.deepEqual(evaluatePilotGates(passing), { decision: 'GO', failed: [] });
});

test('returns NO_GO and names every failed gate', () => {
  const result = evaluatePilotGates({
    ...passing,
    parallelDays: 29,
    duplicateExternalIssues: 1,
    restoreDrillPassed: false
  });
  assert.equal(result.decision, 'NO_GO');
  assert.deepEqual(result.failed.map(({ gate }) => gate), [
    'parallelDays',
    'duplicateExternalIssues',
    'restoreDrillPassed'
  ]);
});
