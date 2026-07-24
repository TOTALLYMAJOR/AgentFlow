interface MetricProps {
  label: string;
  value: string;
  detail?: string;
}

export function Metric({
  label,
  value,
  detail,
}: MetricProps): React.JSX.Element {
  return (
    <div className="metric">
      <span className="metric__label">{label}</span>
      <strong className="metric__value">{value}</strong>
      {detail === undefined ? null : (
        <span className="metric__detail">{detail}</span>
      )}
    </div>
  );
}
