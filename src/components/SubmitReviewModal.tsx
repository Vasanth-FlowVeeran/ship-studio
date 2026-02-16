/**
 * Submit for Review modal.
 *
 * Creates a pull request from the current branch.
 * Supports AI-generated PR titles and descriptions via Claude CLI.
 *
 * @module components/SubmitReviewModal
 */

import { useState } from 'react';
import { createPullRequest } from '../lib/branches';
import { generatePRDescription } from '../lib/ai';
import { commitChanges } from '../lib/git';

interface SubmitReviewModalProps {
  /** Project path for PR operations */
  projectPath: string;
  /** Branch to create PR from */
  branchName: string;
  /** Available base branches */
  baseBranches: string[];
  /** Whether the AI agent CLI is available for AI generation */
  aiAvailable: boolean;
  /** Callback when PR is created */
  onSuccess: (prUrl: string) => void;
  /** Callback to close modal */
  onClose: () => void;
  /** Callback for toast notifications */
  onToast?: (message: string, type?: 'success' | 'error') => void;
}

export function SubmitReviewModal({
  projectPath,
  branchName,
  baseBranches,
  aiAvailable,
  onSuccess,
  onClose,
  onToast,
}: SubmitReviewModalProps) {
  const [title, setTitle] = useState(formatBranchAsTitle(branchName));
  const [description, setDescription] = useState('');
  const [baseBranch, setBaseBranch] = useState(baseBranches[0] || 'main');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [needsCommit, setNeedsCommit] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleGenerate = async () => {
    setIsGenerating(true);
    setError(null);
    setNeedsCommit(false);

    try {
      const result = await generatePRDescription(projectPath, baseBranch);
      setTitle(result.title);
      setDescription(result.description);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message.includes('No changes found')) {
        setNeedsCommit(true);
      } else {
        setError(`AI generation failed: ${message}`);
        onToast?.('Failed to generate PR description', 'error');
      }
    } finally {
      setIsGenerating(false);
    }
  };

  const handleCommitAndGenerate = async () => {
    setIsGenerating(true);
    setError(null);
    setNeedsCommit(false);

    try {
      const committed = await commitChanges(projectPath, 'Updates from Ship Studio');
      if (!committed) {
        setError('No changes to commit.');
        setIsGenerating(false);
        return;
      }

      const result = await generatePRDescription(projectPath, baseBranch);
      setTitle(result.title);
      setDescription(result.description);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(`Failed: ${message}`);
      onToast?.('Failed to generate PR description', 'error');
    } finally {
      setIsGenerating(false);
    }
  };

  const handleSubmit = async () => {
    if (!title.trim()) {
      setError('Title is required');
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const prUrl = await createPullRequest(
        projectPath,
        title.trim(),
        description.trim() || null,
        baseBranch
      );
      onSuccess(prUrl);
      onClose();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      onToast?.('Failed to create pull request', 'error');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    }
  };

  const isBusy = isSubmitting || isGenerating;

  return (
    <div className="submit-review-modal" onKeyDown={handleKeyDown} onClick={onClose}>
      <div className="submit-review-content" onClick={(e) => e.stopPropagation()}>
        <div className="submit-review-header">
          <h2>Submit for Review</h2>
          {aiAvailable && (
            <button
              className="submit-review-generate-btn"
              onClick={() => void handleGenerate()}
              disabled={isBusy}
              title="Generate title and description from your code changes using AI"
            >
              {isGenerating ? (
                <>
                  <span className="submit-review-spinner" />
                  Generating...
                </>
              ) : (
                <>
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M12 2a4 4 0 0 1 4 4c0 1.5-.8 2.8-2 3.4V11h3a4 4 0 0 1 4 4v1a2 2 0 0 1-2 2h-1v2a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-2H5a2 2 0 0 1-2-2v-1a4 4 0 0 1 4-4h3V9.4A4 4 0 0 1 8 6a4 4 0 0 1 4-4z" />
                  </svg>
                  Generate with AI
                </>
              )}
            </button>
          )}
        </div>

        <div className="submit-review-body">
          {needsCommit && (
            <div className="submit-review-commit-prompt">
              <p>Your changes need to be committed before AI can analyze them.</p>
              <button
                className="submit-review-commit-btn"
                onClick={() => void handleCommitAndGenerate()}
                disabled={isBusy}
              >
                {isGenerating ? (
                  <>
                    <span className="submit-review-spinner" />
                    Committing & generating...
                  </>
                ) : (
                  'Commit & Generate'
                )}
              </button>
            </div>
          )}

          <div className="submit-review-field">
            <label className="submit-review-label">Branch</label>
            <div className="publish-branch-info">
              <span className="publish-branch-name">{branchName}</span>
            </div>
          </div>

          <div className="submit-review-field">
            <label className="submit-review-label">Merging into</label>
            <select
              className="submit-review-input"
              value={baseBranch}
              onChange={(e) => setBaseBranch(e.target.value)}
              disabled={isBusy}
            >
              {baseBranches.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </div>

          <div className="submit-review-field">
            <label className="submit-review-label">Title</label>
            <input
              type="text"
              className="submit-review-input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What did you change?"
              autoFocus
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              disabled={isGenerating}
            />
          </div>

          <div className="submit-review-field">
            <label className="submit-review-label">Description (optional)</label>
            <textarea
              className="submit-review-textarea"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Add any additional context..."
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              disabled={isGenerating}
            />
          </div>

          {error && <div className="submit-review-error">{error}</div>}
        </div>

        <div className="submit-review-footer">
          <button className="branch-selector-cancel" onClick={onClose} disabled={isBusy}>
            Cancel
          </button>
          <button
            className="branch-selector-submit"
            onClick={() => void handleSubmit()}
            disabled={isBusy || !title.trim()}
          >
            {isSubmitting ? 'Creating...' : 'Create Pull Request'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Convert a branch name to a human-readable title.
 * e.g., "julian/update-pricing-page" -> "Update pricing page"
 */
function formatBranchAsTitle(branchName: string): string {
  // Remove username prefix if present
  let name = branchName;
  if (name.includes('/')) {
    name = name.split('/').slice(1).join('/');
  }

  // Replace dashes/underscores with spaces and capitalize
  return name.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
