// frontend/src/components/ui/SegmentedControl.jsx
import { ToggleButtonGroup, ToggleButton } from 'react-aria-components';
import './SegmentedControl.css';

export default function SegmentedControl({ items, selected, onChange, 'aria-label': ariaLabel }) {
  return (
    <ToggleButtonGroup
      className="ui-segmented"
      aria-label={ariaLabel}
      selectionMode="single"
      disallowEmptySelection
      selectedKeys={[selected]}
      onSelectionChange={(keys) => {
        const next = [...keys][0];
        if (next != null) onChange(next);
      }}
    >
      {items.map(({ id, label, Icon, srLabel }) => (
        <ToggleButton key={id} id={id} className="ui-segmented-item" aria-label={srLabel}>
          {Icon && <Icon size={14} strokeWidth={1.8} />}
          {label}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}
