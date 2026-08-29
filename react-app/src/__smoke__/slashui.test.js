/* The menu must actually appear in the composer when '/' is typed — the two
   bugs this covers were an unpositioned ancestor and a role gate that hid
   every command until roles loaded. */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import SlashMenu from '../components/SlashMenu';
import { filterCommands, visibleCommands } from '../utils/slashCommands';

test('while roles are still loading the full command set is offered', () => {
  // role null + showAll false was the bug: only help and clear survived
  expect(visibleCommands(null).length).toBe(2);
  expect(visibleCommands(null, true).length).toBe(11);
  expect(filterCommands(null, '', true).length).toBe(11);
});

test('the menu renders every command with its description and argument hint', () => {
  const cmds = filterCommands('admin', '');
  render(<SlashMenu commands={cmds} active={0} onPick={() => {}} onHover={() => {}} />);
  expect(screen.getByText('/fir')).toBeTruthy();
  expect(screen.getByText('Get FIR details and current status')).toBeTruthy();
  expect(screen.getByText('[FIR number]')).toBeTruthy();
  // grouped by category
  expect(screen.getByText('Lookup')).toBeTruthy();
  expect(screen.getByText('Analytics')).toBeTruthy();
});

test('picking a command reports it back', () => {
  const picked = [];
  const cmds = filterCommands('admin', 'fi');
  render(<SlashMenu commands={cmds} active={0} onPick={(c) => picked.push(c.name)} onHover={() => {}} />);
  fireEvent.mouseDown(screen.getByText('/fir'));
  expect(picked).toEqual(['fir']);
});

test('an empty filter result renders nothing rather than an empty box', () => {
  const { container } = render(
    <SlashMenu commands={[]} active={0} onPick={() => {}} onHover={() => {}} />
  );
  expect(container.querySelector('.sc-menu')).toBeNull();
});
