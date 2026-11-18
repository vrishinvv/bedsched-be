export const DIRECTIONS = Object.freeze(['North', 'South', 'East', 'West']);

export function parseDirectionalLocationName(value) {
  const match = String(value || '').trim().match(/^(north|south|east|west)\s*[-_ ]\s*(\d+)$/i);
  if (!match) return null;
  const direction = match[1][0].toUpperCase() + match[1].slice(1).toLowerCase();
  const sectionNumber = Number(match[2]);
  if (!Number.isSafeInteger(sectionNumber) || sectionNumber <= 0) return null;
  return {
    direction,
    sectionNumber,
    sectionName: `${direction} ${sectionNumber}`,
  };
}

export function buildDirectionalConsolidationPlan(locations = []) {
  return locations
    .map((location) => {
      const parsed = parseDirectionalLocationName(location.name);
      return parsed ? { ...location, ...parsed } : null;
    })
    .filter(Boolean)
    .sort((a, b) => (
      DIRECTIONS.indexOf(a.direction) - DIRECTIONS.indexOf(b.direction)
      || a.sectionNumber - b.sectionNumber
      || Number(a.id) - Number(b.id)
    ));
}
