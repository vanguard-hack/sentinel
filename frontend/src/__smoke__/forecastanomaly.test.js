/* detectModelAnomalies: anomaly detection grounded in the deployed QuickML
 * forecast models — is the latest observed month, for a series the model
 * actually knows, outside the range the model's own measured error rate
 * (relMae) says is normal for a series at that level? Not the ad-hoc
 * z-score heuristic (detectAnomalies) — a tolerance tied to real,
 * held-out-validated model accuracy.
 */
import { detectModelAnomalies } from '../utils/predict';

// 12 flat months at 100, so the trailing baseline is unambiguous, plus
// whatever 13th ("latest") month a test wants to check.
const flatHistory = (latest) => [
  ...Array.from({ length: 12 }, (_, i) => ({ month: `2025-${String(i + 1).padStart(2, '0')}`, value: 100 })),
  { month: '2026-01', value: latest },
];

const bundle = (crimeheadLatest, districtLatest) => ({
  crimehead: {
    quality: { relMae: 0.1 },
    series: { crime_1: { label: 'Theft', history: flatHistory(crimeheadLatest) } },
  },
  district: {
    quality: { relMae: 0.1 },
    series: { district_1: { label: 'Bengaluru City', history: flatHistory(districtLatest) } },
  },
});

test('a month far outside the model\'s measured error band is flagged', () => {
  // Baseline 100, relMae 0.1 -> tolerance is roughly +/-25 (1.96*1.2533*0.1*100).
  // 200 is nowhere close to that.
  const alerts = detectModelAnomalies(bundle(200, 100));
  expect(alerts).toHaveLength(1);
  expect(alerts[0]).toMatchObject({ kind: 'head', label: 'Theft', actual: 200, expected: 100 });
});

test('a month within the model\'s measured error band is not flagged', () => {
  const alerts = detectModelAnomalies(bundle(105, 98));
  expect(alerts).toHaveLength(0);
});

test('a series with no relMae (model quality unknown) is skipped, not crashed', () => {
  const fc = { crimehead: { quality: {}, series: { crime_1: { label: 'Theft', history: flatHistory(500) } } } };
  expect(detectModelAnomalies(fc)).toEqual([]);
});

test('a series with fewer than 13 months of history is skipped, not a false positive', () => {
  const fc = {
    crimehead: {
      quality: { relMae: 0.1 },
      series: { crime_1: { label: 'Theft', history: [{ month: '2026-01', value: 500 }] } },
    },
  };
  expect(detectModelAnomalies(fc)).toEqual([]);
});

test('missing bundle sections and a null bundle both resolve to no alerts, not a throw', () => {
  expect(detectModelAnomalies(null)).toEqual([]);
  expect(detectModelAnomalies({})).toEqual([]);
});

test('alerts are sorted by how far outside the band they are, strongest first', () => {
  const alerts = detectModelAnomalies(bundle(210, 400)); // district's deviation is far larger
  expect(alerts.map((a) => a.kind)).toEqual(['district', 'head']);
});
