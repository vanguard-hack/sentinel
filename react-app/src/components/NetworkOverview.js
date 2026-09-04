import React, { useCallback } from 'react';
import GraphCanvas from './GraphCanvas';
import { css } from '../utils/theme';

// Ring-level map of the whole linkage landscape.
//
// One labelled node per ring, in the manner of Connected Papers / Obsidian's
// graph view: drawing every individual put a thousand anonymous dots on screen
// where nothing could be read. Node size is ring membership, and an edge means
// two rings share a district or a crime type — a lead, not a claim that anyone
// co-offended across rings.
//
// The drawing, panning, zooming and picking all live in GraphCanvas, which the
// money-flow map also uses. What is specific to this map is what a node means:
// its colour says only whether it is in focus, and its card reads in rings and
// crimes.
export default function NetworkOverview({ overview, selected, onSelect }) {
  const { nodes, links } = overview;

  // One colour throughout — the only thing colour encodes here is focus.
  // Canvas cannot resolve CSS custom properties, so the accent is read from
  // the stylesheet per paint rather than hardcoded.
  const colorOf = useCallback((n, { active, inFocus, hasFocus, text }) => {
    if (text) return active ? css('--primary-strong') : css('--bg-4');
    if (active) return css('--primary');
    return inFocus && hasFocus ? css('--primary-hover') : css('--text-4');
  }, []);

  const renderTip = useCallback((n) => (
    <>
      <strong>{n.label}</strong>
      <span>{n.size} members · {n.crimes} crimes</span>
      <span>{n.group} · {n.type}</span>
    </>
  ), []);

  return (
    <GraphCanvas
      nodes={nodes}
      links={links}
      selected={selected}
      // The map speaks in ring ids; the canvas speaks in node indices.
      onSelect={(i) => onSelect && onSelect(i == null ? null : nodes[i].ring)}
      colorOf={colorOf}
      renderTip={renderTip}
      ariaLabel="network overview"
    />
  );
}
