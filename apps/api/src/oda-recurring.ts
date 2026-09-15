import { normalizeOdaCategory, type OdaLine, type OdaMonth } from '@ofd/domain';

export function previousSettlementMonth(month: string): string {
  const [year, number] = month.split('-').map(Number);
  return number === 1 ? `${year! - 1}-12` : `${year}-${String(number! - 1).padStart(2, '0')}`;
}
const normalizedDescription = (text: string) => text.normalize('NFKC').toLowerCase()
  .replace(/\d{4}[-/.]\d{1,2}|\d{1,2}\s*월/g, '').replace(/[\s\p{P}]/gu, '');
export function recurringCandidates(previous: OdaMonth, current: OdaMonth) {
  const imported = new Set(current.lines.map(line => line.externalId));
  type IndexEntry = { count: number; first: OdaLine[] };
  const descriptions = new Map<string, IndexEntry>();
  const amounts = new Map<string, IndexEntry>();
  const intersections = new Map<string, number>();
  const add = (map: Map<string, IndexEntry>, key: string, line: OdaLine) => {
    const entry = map.get(key) ?? { count: 0, first: [] }; entry.count++;
    if (entry.first.length < 3) entry.first.push(line); map.set(key, entry);
  };
  for (const line of current.lines.filter(line => line.kind === 'expense')) {
    const category = normalizeOdaCategory(line.category);
    const description = normalizedDescription(line.description);
    add(descriptions, JSON.stringify([category, description]), line);
    add(amounts, JSON.stringify([category, line.amount]), line);
    const both = JSON.stringify([category, description, line.amount]);
    intersections.set(both, (intersections.get(both) ?? 0) + 1);
  }
  return previous.lines.filter(line => line.kind === 'expense' && line.reviewed && line.amount > 0
    && ['rent', 'labor', 'utilities'].includes(normalizeOdaCategory(line.category))).map(line => {
    const category = normalizeOdaCategory(line.category);
    const description = normalizedDescription(line.description);
    const byDescription = descriptions.get(JSON.stringify([category, description]));
    const byAmount = amounts.get(JSON.stringify([category, line.amount]));
    const matchCount = (byDescription?.count ?? 0) + (byAmount?.count ?? 0)
      - (intersections.get(JSON.stringify([category, description, line.amount])) ?? 0);
    const matches = [...new Map([...(byDescription?.first ?? []), ...(byAmount?.first ?? [])].map(item => [item.id, item])).values()].slice(0, 3);
    const status = imported.has(`repeat:${previous.month}:${line.id}`) ? 'already_added' : matchCount ? 'similar' : 'available';
    return { lineId: line.id, description: line.description, category, amount: line.amount, vat: line.vat,
      previousDate: line.date, status, matchCount,
      matches: matches.map(item => ({ lineId: item.id, date: item.date, description: item.description, amount: item.amount })) };
  });
}
