/**
 * Selectable template card for the "Start from Scratch" grid in Create Project.
 *
 * Wraps the shared {@link Button} primitive (ghost variant) so the grid card
 * participates in the design-system button system, while keeping its grid-card
 * layout via the `stack-card` classes (which override the base button box model;
 * feature CSS loads after base.css). Renders the template name, the description,
 * and a check mark when selected.
 *
 * @module components/dashboard/TemplateCard
 */

import { Button } from '../primitives/Button';

interface TemplateCardProps {
  name: string;
  description: string;
  /** Whether this card is the active selection (drives the ring + check). */
  selected: boolean;
  onSelect: () => void;
}

export function TemplateCard({ name, description, selected, onSelect }: TemplateCardProps) {
  return (
    <Button
      variant="ghost"
      className={`stack-card${selected ? ' stack-card-selected' : ''}`}
      aria-pressed={selected}
      onClick={onSelect}
    >
      <span className="stack-card-name">{name}</span>
      <span className="stack-card-desc">{description}</span>
      {selected && (
        <div className="stack-card-check">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </div>
      )}
    </Button>
  );
}
