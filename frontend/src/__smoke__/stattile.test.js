// StatTile already had the compact "plain" look Reports.js uses everywhere.
// BoardUI's stat-cards doc adds a second look for header-of-section tiles: a
// gradient-tinted icon tile and a footer band for the comparison text. This
// only checks the new prop's effect — StatTile's existing count-up/share/
// trend behavior is untouched and already covered by using it in Reports.js.
import React from 'react';
import { render, screen } from '@testing-library/react';
import { LayoutGrid } from 'lucide-react';
import StatTile from '../components/charts/StatTile';

test('the plain variant is the default, no footer band', () => {
  render(<StatTile Icon={LayoutGrid} label="FIRs" value={120} sub="this month" />);
  expect(document.querySelector('.st-tile')).not.toHaveClass('st-tile-footer');
});

test('the footer variant renders the footer band with its comparison text', () => {
  render(
    <StatTile Icon={LayoutGrid} label="FIRs" value={120} variant="footer" footerText="+12% vs last month" />
  );
  expect(document.querySelector('.st-tile')).toHaveClass('st-tile-footer');
  expect(screen.getByText('+12% vs last month')).toBeInTheDocument();
});
