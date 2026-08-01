import type { Note } from '../types';

interface BreadcrumbsProps {
  path: Note[];
  onZoom: (id: string) => void;
}

export function Breadcrumbs({ path, onZoom }: BreadcrumbsProps) {
  if (path.length <= 1) return <nav className="crumbs" aria-label="Breadcrumb" />;
  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      {path.map((note, i) => {
        const label = i === 0 ? note.text.trim() || 'Home' : note.text.trim() || 'Untitled';
        const isLast = i === path.length - 1;
        return (
          <span key={note.id} className="crumb-wrap">
            {i > 0 && <span className="crumb-sep">/</span>}
            {isLast ? (
              <span className="crumb current">{label}</span>
            ) : (
              <button className="crumb" onClick={() => onZoom(note.id)}>
                {label}
              </button>
            )}
          </span>
        );
      })}
    </nav>
  );
}
