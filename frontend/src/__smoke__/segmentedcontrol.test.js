// frontend/src/__smoke__/segmentedcontrol.test.js
//
// The theme toggle used to be sidebar-only markup (`sb-theme-seg`); this is
// the same switcher pulled out into a reusable primitive so TopBar can host
// it too. Single-select with `disallowEmptySelection` is a mutually-exclusive
// choice, so react-aria-components' ToggleButtonGroup renders it as a real
// radiogroup (role="radio" / aria-checked) rather than role="button" with
// aria-pressed — see node_modules/react-aria/dist/private/button/useToggleButtonGroup.mjs.
// The selected item is exposed for styling via aria-checked rather than a
// hand-rolled `active` class.
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import SegmentedControl from '../components/ui/SegmentedControl';

const items = [{ id: 'light', label: 'Light' }, { id: 'dark', label: 'Dark' }];

test('the selected option is marked checked', () => {
  render(<SegmentedControl items={items} selected="light" onChange={() => {}} aria-label="Theme" />);
  expect(screen.getByRole('radio', { name: 'Light' })).toHaveAttribute('aria-checked', 'true');
  expect(screen.getByRole('radio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'false');
});

test('clicking an option calls onChange with its id', () => {
  const onChange = jest.fn();
  render(<SegmentedControl items={items} selected="light" onChange={onChange} aria-label="Theme" />);
  fireEvent.click(screen.getByRole('radio', { name: 'Dark' }));
  expect(onChange).toHaveBeenCalledWith('dark');
});

// Icon-only items (empty visible label, e.g. the theme toggle's Sun/Moon
// glyphs) have nothing for a screen reader to read unless a `srLabel` is
// carried through to the underlying ToggleButton as aria-label.
test('icon-only items carry an accessible name via srLabel', () => {
  const iconItems = [
    { id: 'light', label: '', srLabel: 'Light mode' },
    { id: 'dark', label: '', srLabel: 'Dark mode' },
  ];
  render(<SegmentedControl items={iconItems} selected="light" onChange={() => {}} aria-label="Theme" />);
  expect(screen.getByRole('radio', { name: 'Light mode' })).toBeInTheDocument();
  expect(screen.getByRole('radio', { name: 'Dark mode' })).toBeInTheDocument();
});
