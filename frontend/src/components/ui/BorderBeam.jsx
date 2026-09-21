import './BorderBeam.css';

// The sweep runs as a plain CSS @keyframes animation on --beam-angle (see
// BorderBeam.css), not motion/react's animate() — Motion never produced a
// running animation for a bare custom-property target (confirmed live:
// glow.getAnimations() came back empty), while a @property-typed custom
// property is exactly what native CSS keyframe animation is built to drive.
export default function BorderBeam({ active, children, className }) {
  return (
    <div className={`ui-border-beam ${className || ''} ${active ? 'active' : ''}`}>
      {active && <span className="ui-border-beam-glow" aria-hidden="true" />}
      {children}
    </div>
  );
}
