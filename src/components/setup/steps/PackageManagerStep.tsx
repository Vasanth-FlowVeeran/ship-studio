/**
 * Wizard Step 1: Package Manager & Node.js
 *
 * Shows SetupItem rows for homebrew, node, and npm_fix (if present).
 */

import { SetupItem } from '../SetupItem';
import {
  SetupItem as SetupItemType,
  getStepItems,
  getBlockingDependencies,
} from '../../../lib/setup';

interface PackageManagerStepProps {
  items: SetupItemType[];
  onItemAction: (itemId: string) => void;
  activeItemId: string | null;
  terminalActive: boolean;
}

export function PackageManagerStep({
  items,
  onItemAction,
  activeItemId,
  terminalActive,
}: PackageManagerStepProps) {
  const stepItems = getStepItems('package-manager', items);
  const isAnyActionInProgress = activeItemId !== null || terminalActive;

  return (
    <div className="wizard-step-items">
      {stepItems.map((item) => {
        const blockedBy = getBlockingDependencies(item.id, items);
        const isBlocked = blockedBy.length > 0 && item.status !== 'ready';
        const displayItem: SetupItemType = isBlocked ? { ...item, status: 'blocked' } : item;

        return (
          <SetupItem
            key={item.id}
            item={displayItem}
            blockedBy={blockedBy}
            onAction={() => onItemAction(item.id)}
            isActionInProgress={activeItemId === item.id}
            isAnyActionInProgress={isAnyActionInProgress}
          />
        );
      })}
    </div>
  );
}
