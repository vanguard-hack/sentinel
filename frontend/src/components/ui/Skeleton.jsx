import React from 'react';
import './Skeleton.css';

// Placeholder shape that holds a layout's geometry while data is loading.
// Sized to match the content it stands in for — a skeleton that doesn't
// reserve the right space causes the layout shift it's meant to prevent.
export default function Skeleton({ variant = 'text', width, height, className = '' }) {
  const style = {};
  if (width !== undefined) style.width = typeof width === 'number' ? `${width}px` : width;
  if (height !== undefined) style.height = typeof height === 'number' ? `${height}px` : height;
  return (
    <span
      aria-hidden="true"
      className={`ui-skeleton ui-skeleton-${variant}${className ? ` ${className}` : ''}`}
      style={style}
    />
  );
}
