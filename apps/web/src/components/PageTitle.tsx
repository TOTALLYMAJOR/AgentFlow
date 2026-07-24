interface PageTitleProps {
  title: string;
  description: string;
  actions?: React.ReactNode;
}

export function PageTitle({
  title,
  description,
  actions,
}: PageTitleProps): React.JSX.Element {
  return (
    <header className="page-title">
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {actions === undefined ? null : (
        <div className="page-title__actions">{actions}</div>
      )}
    </header>
  );
}
