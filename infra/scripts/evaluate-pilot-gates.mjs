import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export function evaluatePilotGates(metrics) {
  const checks = [
    ['pilotStores', metrics.pilotStores === 2, 'exactly two representative stores must be in the pilot'],
    ['parallelDays', metrics.parallelDays >= 30, 'parallel operation must run for at least 30 days'],
    ['ledgerReconciliationRate', metrics.ledgerReconciliationRate === 1, 'order/delivery/receipt reconciliation must be 100%'],
    ['taxAmountDifferenceWon', metrics.taxAmountDifferenceWon === 0, 'tax supply/VAT difference must be 0 won'],
    ['duplicateExternalIssues', metrics.duplicateExternalIssues === 0, 'duplicate external issues must be 0'],
    ['pendingOutbox', metrics.pendingOutbox === 0, 'pending outbox events must be 0'],
    ['deadLetters', metrics.deadLetters === 0, 'dead letters must be 0'],
    ['authorizationTestsPassed', metrics.authorizationTestsPassed === true, 'cross-store/role authorization tests must pass'],
    ['restoreDrillPassed', metrics.restoreDrillPassed === true, 'backup restore drill must pass'],
    ['mobileTaskSuccessRate', metrics.mobileTaskSuccessRate >= 0.95, 'store mobile task success must be at least 95%'],
    ['approvalSlaRate', metrics.approvalSlaRate >= 0.95, 'HQ approval SLA attainment must be at least 95%'],
    ['unresolvedSeverity1', metrics.unresolvedSeverity1 === 0, 'unresolved severity-1 incidents must be 0']
  ];

  const failed = checks
    .filter(([, passed]) => !passed)
    .map(([gate, , reason]) => ({ gate, reason }));
  return { decision: failed.length === 0 ? 'GO' : 'NO_GO', failed };
}

export async function runGateFile(filePath) {
  const metrics = JSON.parse(await readFile(filePath, 'utf8'));
  return evaluatePilotGates(metrics);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('Usage: node infra/scripts/evaluate-pilot-gates.mjs <metrics.json>');
    process.exitCode = 2;
  } else {
    const result = await runGateFile(filePath);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.decision === 'GO' ? 0 : 1;
  }
}
