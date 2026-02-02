/**
 * Modal for configuring notification sounds.
 */

import { useState, useRef } from 'react';
import {
  NotificationSettings,
  ALL_PRESETS,
  getPresetDisplayName,
  playPresetSound,
  playCustomSound,
} from '../lib/sounds';

interface NotificationSettingsModalProps {
  settings: NotificationSettings;
  onSave: (settings: NotificationSettings) => void;
  onClose: () => void;
}

export function NotificationSettingsModal({
  settings,
  onSave,
  onClose,
}: NotificationSettingsModalProps) {
  const [localSettings, setLocalSettings] = useState<NotificationSettings>(settings);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    }
  };

  const handleSave = () => {
    onSave(localSettings);
    onClose();
  };

  const handleSelectCustomSound = () => {
    fileInputRef.current?.click();
  };

  const handleFileSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        setLocalSettings((prev) => ({
          ...prev,
          sound: {
            type: 'custom',
            customDataUrl: dataUrl,
            customFileName: file.name,
          },
        }));
      };
      reader.readAsDataURL(file);
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handlePreviewSound = async () => {
    if (localSettings.sound.type === 'preset' && localSettings.sound.preset) {
      playPresetSound(localSettings.sound.preset);
    } else if (localSettings.sound.type === 'custom' && localSettings.sound.customDataUrl) {
      await playCustomSound(localSettings.sound.customDataUrl);
    }
  };

  return (
    <div className="notification-settings-modal" onKeyDown={handleKeyDown} onClick={onClose}>
      <div className="notification-settings-content" onClick={(e) => e.stopPropagation()}>
        <div className="notification-settings-header">
          <h2>Notification Sounds</h2>
          <p>Play a sound when Claude needs your input</p>
        </div>

        <div className="notification-settings-body">
          <div className="notification-setting-section">
            <div className="notification-setting-row">
              <div className="notification-setting-info">
                <div className="notification-setting-title">Enable sounds</div>
                <div className="notification-setting-description">
                  Play a sound when Claude finishes and is waiting for you
                </div>
              </div>
              <label className="notification-toggle">
                <input
                  type="checkbox"
                  checked={localSettings.enabled}
                  onChange={(e) =>
                    setLocalSettings((prev) => ({ ...prev, enabled: e.target.checked }))
                  }
                />
                <span className="notification-toggle-slider" />
              </label>
            </div>

            {localSettings.enabled && (
              <div className="notification-sound-picker">
                <div className="notification-sound-options">
                  {ALL_PRESETS.map((preset) => (
                    <button
                      key={preset}
                      className={`notification-sound-option ${
                        localSettings.sound.type === 'preset' &&
                        localSettings.sound.preset === preset
                          ? 'selected'
                          : ''
                      }`}
                      onClick={() =>
                        setLocalSettings((prev) => ({
                          ...prev,
                          sound: { type: 'preset', preset },
                        }))
                      }
                    >
                      {getPresetDisplayName(preset)}
                    </button>
                  ))}
                  <button
                    className={`notification-sound-option ${
                      localSettings.sound.type === 'custom' ? 'selected' : ''
                    }`}
                    onClick={handleSelectCustomSound}
                  >
                    Custom...
                  </button>
                </div>

                {localSettings.sound.type === 'custom' && localSettings.sound.customFileName && (
                  <div className="notification-custom-path">
                    {localSettings.sound.customFileName}
                  </div>
                )}

                <button
                  className="notification-preview-btn"
                  onClick={() => void handlePreviewSound()}
                >
                  <svg width={12} height={12} viewBox="0 0 24 24" fill="currentColor">
                    <polygon points="5 3 19 12 5 21 5 3" />
                  </svg>
                  Preview
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="notification-settings-footer">
          <button className="notification-settings-cancel" onClick={onClose}>
            Cancel
          </button>
          <button className="notification-settings-save" onClick={handleSave}>
            Save
          </button>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept="audio/*"
          style={{ display: 'none' }}
          onChange={handleFileSelected}
        />
      </div>
    </div>
  );
}
