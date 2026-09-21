import React from 'react';
import { render, screen, fireEvent, waitForElementToBeRemoved } from '@testing-library/react';
import Tooltip from '../components/ui/Tooltip';

test('the label appears when the trigger receives focus', async () => {
  render(<Tooltip label="Collapse sidebar"><span>icon</span></Tooltip>);
  fireEvent.focus(screen.getByRole('button'));
  expect(await screen.findByRole('tooltip')).toHaveTextContent('Collapse sidebar');
});

test('the tooltip clears when the trigger blurs', async () => {
  render(<Tooltip label="Collapse sidebar"><span>icon</span></Tooltip>);
  fireEvent.focus(screen.getByRole('button'));
  await screen.findByRole('tooltip');
  fireEvent.blur(screen.getByRole('button'));
  await waitForElementToBeRemoved(() => screen.queryByRole('tooltip'));
});

test('clicking the trigger still fires onPress', async () => {
  const onPress = jest.fn();
  render(<Tooltip label="Collapse sidebar" onPress={onPress}><span>icon</span></Tooltip>);
  fireEvent.click(screen.getByRole('button'));
  expect(onPress).toHaveBeenCalledTimes(1);
});
