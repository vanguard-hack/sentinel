import React from 'react';
import { render, screen, fireEvent, waitForElementToBeRemoved } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Tooltip from '../components/ui/Tooltip';

test('the label appears when the trigger receives focus', async () => {
  render(<Tooltip label="Collapse sidebar"><span>icon</span></Tooltip>);
  await userEvent.tab();
  expect(await screen.findByRole('tooltip')).toHaveTextContent('Collapse sidebar');
});

test('the tooltip clears when the trigger blurs', async () => {
  render(<Tooltip label="Collapse sidebar"><span>icon</span></Tooltip>);
  await userEvent.tab();
  await screen.findByRole('tooltip');
  await userEvent.tab();
  // After blur, tooltip should not be present
  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
});

test('clicking the trigger still fires onPress', async () => {
  const onPress = jest.fn();
  render(<Tooltip label="Collapse sidebar" onPress={onPress}><span>icon</span></Tooltip>);
  fireEvent.click(screen.getByRole('button'));
  expect(onPress).toHaveBeenCalledTimes(1);
});
