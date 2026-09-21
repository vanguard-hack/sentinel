import { motion } from 'motion/react';
import './BorderBeam.css';

export default function BorderBeam({ active, children, className }) {
  return (
    <div className={`ui-border-beam ${className || ''} ${active ? 'active' : ''}`}>
      {active && (
        <motion.span
          className="ui-border-beam-glow"
          aria-hidden="true"
          animate={{ '--beam-angle': ['0deg', '360deg'] }}
          transition={{ duration: 3, repeat: Infinity, ease: 'linear' }}
        />
      )}
      {children}
    </div>
  );
}
