import type { PortionData } from '@carbbook/core';
import { unitLabel } from './format';

export function UnitPicker(props: {
  label: string;
  units: string[];
  portions: PortionData[];
  value: string;
  onChange: (unit: string) => void;
}) {
  const units = props.units.includes(props.value) ? props.units : [props.value, ...props.units];
  return (
    <select aria-label={props.label} value={props.value} onChange={(e) => props.onChange(e.target.value)}>
      {units.map((unit) => (
        <option key={unit} value={unit}>
          {props.units.includes(unit) ? unitLabel(unit, props.portions) : `${unitLabel(unit, props.portions)} (not valid)`}
        </option>
      ))}
    </select>
  );
}
