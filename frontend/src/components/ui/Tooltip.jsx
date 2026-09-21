import React, { useState, useRef, useEffect } from 'react';
import { Button } from 'react-aria-components';
import './Tooltip.css';

export default function Tooltip({
  label, className, onPress, children, placement = 'top', disabled = false, ...rest
}) {
  const [isOpen, setIsOpen] = useState(false);
  const buttonRef = useRef(null);

  useEffect(() => {
    const button = buttonRef.current;
    if (!button) return;

    const handleFocus = () => {
      setIsOpen(true);
    };
    const handleBlur = () => {
      // Use setTimeout with 0 delay to ensure the blur event is processed
      // before React state updates, allowing waitForElementToBeRemoved to work properly
      setTimeout(() => setIsOpen(false), 0);
    };

    button.addEventListener('focus', handleFocus, true);
    button.addEventListener('blur', handleBlur, true);

    return () => {
      button.removeEventListener('focus', handleFocus, true);
      button.removeEventListener('blur', handleBlur, true);
    };
  }, []);

  if (disabled || !label) {
    return <>{children}</>;
  }

  return (
    <div className="ui-tooltip-trigger-wrapper" style={{ display: 'inline-block', position: 'relative' }}>
      <Button
        ref={buttonRef}
        className={className}
        onPress={onPress}
        aria-label={label}
        {...rest}
      >
        {children}
      </Button>
      {isOpen && (
        <div
          className="ui-tooltip"
          role="tooltip"
          data-placement={placement}
          style={{
            position: 'absolute',
            zIndex: 1000,
            ...(placement === 'top' && { bottom: '100%', left: '50%', transform: 'translateX(-50%)' }),
            ...(placement === 'bottom' && { top: '100%', left: '50%', transform: 'translateX(-50%)' }),
          }}
        >
          <svg width={8} height={8} viewBox="0 0 8 8" className="ui-tooltip-arrow">
            <path d="M0 0 L4 4 L8 0 Z" />
          </svg>
          {label}
        </div>
      )}
    </div>
  );
}
