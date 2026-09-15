/* The socio-economic map's readout.
 *
 * It used to live in a fixed panel in the side column, carrying a min-height so
 * it held its shape while empty — so a box reading "Hover a district for its
 * numbers" sat there permanently whether or not anyone was hovering, and
 * reading a value meant looking away from the district being pointed at.
 * The numbers now appear on the district itself.
 */
import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react';

global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };

jest.mock('topojson-client', () => ({
  feature: () => ({
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: { st_nm: 'Karnataka', district: 'Bengaluru Urban' },
        geometry: { type: 'Polygon', coordinates: [[[77, 12], [78, 12], [78, 13], [77, 13], [77, 12]]] } },
      { type: 'Feature', properties: { st_nm: 'Karnataka', district: 'Mysuru' },
        geometry: { type: 'Polygon', coordinates: [[[76, 12], [77, 12], [77, 13], [76, 13], [76, 12]]] } },
    ],
  }),
}), { virtual: true });

global.fetch = () => Promise.resolve({ json: () => Promise.resolve({ objects: { districts: {} } }) });

const SocioCrimeMap = require('../components/SocioCrimeMap').default;

const crimeByDistrict = [
  { label: 'Bengaluru Urban', value: 4200 },
  { label: 'Mysuru', value: 900 },
];

const draw = async () => {
  const { container } = render(<SocioCrimeMap crimeByDistrict={crimeByDistrict} />);
  await waitFor(() => expect(container.querySelector('.scm-shape')).not.toBeNull());
  return container;
};

test('nothing is parked on screen waiting to be hovered', async () => {
  const c = await draw();
  expect(c.textContent).not.toMatch(/hover a district/i);
  expect(c.querySelector('.scm-tip')).toBeNull();
});

test('hovering a district puts its numbers on the map', async () => {
  const c = await draw();
  fireEvent.mouseEnter(c.querySelectorAll('.scm-shape')[0]);
  const tip = c.querySelector('.scm-tip-float');
  expect(tip).not.toBeNull();
  expect(tip.textContent).toMatch(/Registered cases/);
  expect(tip.textContent).toMatch(/Cases per lakh/);
});

test('the card is positioned on the district, not in a fixed corner', async () => {
  const c = await draw();
  const shapes = c.querySelectorAll('.scm-shape');
  fireEvent.mouseEnter(shapes[0]);
  const first = c.querySelector('.scm-tip-float').style.left;
  fireEvent.mouseEnter(shapes[1]);
  const second = c.querySelector('.scm-tip-float').style.left;
  expect(first).toMatch(/%$/);
  expect(first).not.toBe(second);
});

test('leaving the map takes the card with it', async () => {
  const c = await draw();
  fireEvent.mouseEnter(c.querySelectorAll('.scm-shape')[0]);
  expect(c.querySelector('.scm-tip-float')).not.toBeNull();
  fireEvent.mouseLeave(c.querySelector('.scm-svg'));
  expect(c.querySelector('.scm-tip-float')).toBeNull();
});

test('the legend and the correlation reading are still there', async () => {
  const c = await draw();
  expect(c.querySelector('.scm-legend')).not.toBeNull();
  expect(c.querySelector('.scm-corr').textContent).toMatch(/r = -?\d/);
});
