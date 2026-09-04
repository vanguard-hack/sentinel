import React, { useCallback, useMemo } from 'react';
import GraphCanvas from './GraphCanvas';
import { css } from '../utils/theme';
import { formatRs } from '../utils/financial';

/* Money-flow map.
 *
 * The crime-network map's twin, on purpose: same renderer (GraphCanvas), same
 * precomputed seeded layout, same focus-to-trace interaction. An officer who
 * has learned to read one reads the other without being taught twice.
 *
 * What differs is what a node means. On the ring map colour carries only focus;
 * here it carries the KIND of account, because "the money left a person and
 * landed in four mules" is the finding, and a map that painted all four the
 * same colour would hide it. Four kinds is few enough to stay legible and each
 * one is named in the legend, so identity is never colour-alone.
 */
const KINDS = [
  { key: 'Entity', label: 'Entity of interest', token: '--rp-cat-0' },
  { key: 'Mule', label: 'Mule account', token: '--rp-cat-1' },
  { key: 'Shell', label: 'Shell account', token: '--rp-cat-2' },
  { key: 'Counterparty', label: 'Counterparty', token: '--rp-cat-3' },
];

export default function MoneyFlowMap({ map, selected, onSelect }) {
  const { nodes, links } = map;

  const colorOf = useCallback((n, { active, inFocus, hasFocus, text }) => {
    if (text) return active ? css('--primary-strong') : css('--bg-4');
    const kind = KINDS.find((k) => k.key === n.kind) || KINDS[3];
    // Out of focus the map recedes to one neutral, exactly as the ring map
    // does — colour identifies, focus is what the eye follows.
    if (hasFocus && !inFocus) return css('--text-4');
    return css(kind.token);
  }, []);

  const renderTip = useCallback((n) => (
    <>
      <strong>{n.label}</strong>
      <span>
        {n.kind}{n.tier ? ` · ${n.tier} risk` : ''} · {formatRs(n.value)} moved
      </span>
      <span>{n.inCount} in · {n.outCount} out{n.ifsc ? ` · ${n.ifsc}` : ''}</span>
    </>
  ), []);

  // Only the kinds actually present, so the key never promises a colour the
  // map does not use.
  const legend = useMemo(() => {
    const present = new Set(nodes.map((n) => n.kind));
    return KINDS.filter((k) => present.has(k.key))
      .map((k) => ({ label: k.label, color: `var(${k.token})` }));
  }, [nodes]);

  return (
    <GraphCanvas
      nodes={nodes}
      links={links}
      selected={selected}
      onSelect={onSelect}
      colorOf={colorOf}
      labelAlways={(n) => n.kind === 'Entity'}
      renderTip={renderTip}
      legend={legend}
      ariaLabel="money-flow map"
    />
  );
}
