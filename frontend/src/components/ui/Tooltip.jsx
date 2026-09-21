import {
  Button, OverlayArrow, Tooltip as AriaTooltip, TooltipTrigger,
} from 'react-aria-components';
import './Tooltip.css';

export default function Tooltip({
  label, className, onPress, children, placement = 'top', disabled = false, ...rest
}) {
  if (disabled || !label) {
    return <>{children}</>;
  }
  return (
    <TooltipTrigger delay={300} closeDelay={0}>
      <Button className={className} onPress={onPress} aria-label={label} {...rest}>
        {children}
      </Button>
      <AriaTooltip className="ui-tooltip" placement={placement} offset={6}>
        <OverlayArrow>
          <svg width={8} height={8} viewBox="0 0 8 8" className="ui-tooltip-arrow">
            <path d="M0 0 L4 4 L8 0 Z" />
          </svg>
        </OverlayArrow>
        {label}
      </AriaTooltip>
    </TooltipTrigger>
  );
}
