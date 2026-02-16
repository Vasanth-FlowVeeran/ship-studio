/**
 * Horizontal step indicator for the onboarding wizard.
 *
 * Shows numbered dots with connecting lines. Steps can be
 * completed (green check), current (highlighted), or upcoming (dim).
 */

import { WIZARD_STEPS, type WizardStepId } from '../../lib/setup';

interface WizardStepIndicatorProps {
  currentStep: WizardStepId;
  completedSteps: Set<WizardStepId>;
}

export function WizardStepIndicator({ currentStep, completedSteps }: WizardStepIndicatorProps) {
  const currentIndex = WIZARD_STEPS.findIndex((s) => s.id === currentStep);

  return (
    <div className="wizard-indicator">
      {WIZARD_STEPS.map((step, index) => {
        const isCompleted = completedSteps.has(step.id);
        const isCurrent = step.id === currentStep;
        const isPast = index < currentIndex;

        let dotClass = 'wizard-indicator-dot';
        if (isCompleted) dotClass += ' completed';
        else if (isCurrent) dotClass += ' current';
        else if (isPast) dotClass += ' past';

        return (
          <div key={step.id} className="wizard-indicator-step">
            {index > 0 && (
              <div
                className={`wizard-indicator-line ${isCompleted || isCurrent || isPast ? 'active' : ''}`}
              />
            )}
            <div className={dotClass}>
              {isCompleted ? (
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path
                    d="M3 7l3 3 5-5"
                    stroke="white"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              ) : (
                <span>{index + 1}</span>
              )}
            </div>
            <span
              className={`wizard-indicator-label ${isCurrent ? 'current' : ''} ${isCompleted ? 'completed' : ''}`}
            >
              {step.title}
            </span>
          </div>
        );
      })}
    </div>
  );
}
