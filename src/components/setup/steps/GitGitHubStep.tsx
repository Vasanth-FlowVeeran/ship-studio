/**
 * Wizard Step 2: Git & GitHub
 *
 * Shows SetupItem rows for git, gh, and gh_auth.
 * gh_auth is treated as required in this step (not optional).
 */

import { SetupItem } from '../SetupItem';
import {
  SetupItem as SetupItemType,
  getStepItems,
  getBlockingDependencies,
} from '../../../lib/setup';

interface GitGitHubStepProps {
  items: SetupItemType[];
  onItemAction: (itemId: string) => void;
  activeItemId: string | null;
  terminalActive: boolean;
}

export function GitGitHubStep({
  items,
  onItemAction,
  activeItemId,
  terminalActive,
}: GitGitHubStepProps) {
  const stepItems = getStepItems('git-github', items);
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
