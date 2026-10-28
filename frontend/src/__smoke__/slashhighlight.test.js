// Slash commands read as commands wherever they appear, and only real ones.
import { render } from '@testing-library/react';
import { renderInline } from '../utils/richFormat';

test('a command in backticks gets the command style', () => {
  const { container } = render(<div>{renderInline('Use `/fir [FIR number]` to look one up')}</div>);
  expect(container.querySelector('code.rf-cmd').textContent).toBe('/fir [FIR number]');
});

test('ordinary inline code is left as code', () => {
  const { container } = render(<div>{renderInline('Column `CaseMaster.CrimeNo` and path `/usr/bin`')}</div>);
  const codes = [...container.querySelectorAll('code')];
  expect(codes[0].className).toBe('');
  // A path starts with "/" too, but "/usr/bin" is not a command.
  expect(codes[1].className).toBe('');
});
