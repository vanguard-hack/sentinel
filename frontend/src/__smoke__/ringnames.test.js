/* Ring and person naming.
 *
 * Accused names in the FIR schema lead with an initial and sometimes carry a
 * quoted alias: `D. Puneeth Naik`, `B. Basavaraj Pai "Chief"`. Every ring label
 * in Crime Links was built with name.split(' ')[0], which returns "D." — so the
 * explorer showed "D.'s ring" three times over and identified nobody.
 *
 * The initial is data, not a name. These lock that distinction in place.
 */
import { personName, personShortName, ringName } from '../utils/crimelinks';

describe('person naming', () => {
  it('skips the leading initial rather than treating it as the name', () => {
    expect(personName('D. Puneeth Naik')).toBe('Puneeth Naik');
    expect(personShortName('D. Puneeth Naik')).toBe('Puneeth');
  });

  it('never returns a bare initial', () => {
    for (const n of ['D. Puneeth Naik', 'N. Raghavendra Biradar', 'V. Anitha Angadi']) {
      expect(personShortName(n)).not.toMatch(/^[A-Za-z]\.?$/);
    }
  });

  it('drops a quoted alias from the formal name', () => {
    expect(personName('B. Basavaraj Pai "Chief"')).toBe('Basavaraj Pai');
  });

  it('handles a name with no initial at all', () => {
    expect(personName('Kumar')).toBe('Kumar');
    expect(personShortName('Kumar')).toBe('Kumar');
  });
});

describe('ring naming', () => {
  it('names a ring after its leader, not their initial', () => {
    expect(ringName({ name: 'D. Puneeth Naik' })).toBe('Puneeth Naik’s ring');
  });

  it('prefers the alias, which is what a ring is actually known by', () => {
    expect(ringName({ name: 'B. Basavaraj Pai "Chief"' })).toBe('Chief’s ring');
  });

  it('says so plainly when there is no leader, rather than "—’s ring"', () => {
    expect(ringName(null)).toBe('Unnamed ring');
    expect(ringName({})).toBe('Unnamed ring');
  });

  it('gives different leaders different ring names', () => {
    const names = ['D. Puneeth Naik', 'D. Anitha Rao', 'D. Suresh Gowda'].map(
      (n) => ringName({ name: n })
    );
    expect(new Set(names).size).toBe(3);
  });
});
