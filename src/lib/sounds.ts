/**
 * Sound utilities for notification sounds.
 * Supports both preset Web Audio API sounds and custom audio files.
 */

/** Available preset sounds */
export type PresetSound = 'ding' | 'chime' | 'pop' | 'bell' | 'subtle' | 'bruh';

/** Sound configuration */
export interface SoundConfig {
  type: 'preset' | 'custom';
  preset?: PresetSound;
  customPath?: string;
  /** Base64 data URL for custom sounds (stored in localStorage) */
  customDataUrl?: string;
  /** Display name for custom sound file */
  customFileName?: string;
}

/** Notification settings */
export interface NotificationSettings {
  /** Whether notification sounds are enabled */
  enabled: boolean;
  /** Sound to play when Claude finishes and needs input */
  sound: SoundConfig;
}

/** Default notification settings */
export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  enabled: true,
  sound: { type: 'preset', preset: 'ding' },
};

/** Oscillator-based preset sound definitions */
interface OscillatorPreset {
  kind: 'oscillator';
  frequency: number;
  type: OscillatorType;
  duration: number;
  attack: number;
  decay: number;
}

/** File-based preset sound definitions */
interface FilePreset {
  kind: 'file';
  path: string;
}

type PresetConfig = OscillatorPreset | FilePreset;

/** Preset sound definitions */
const PRESET_SOUNDS: Record<PresetSound, PresetConfig> = {
  ding: {
    kind: 'oscillator',
    frequency: 880,
    type: 'sine',
    duration: 0.15,
    attack: 0.01,
    decay: 0.14,
  },
  chime: {
    kind: 'oscillator',
    frequency: 1047,
    type: 'sine',
    duration: 0.3,
    attack: 0.01,
    decay: 0.29,
  },
  pop: {
    kind: 'oscillator',
    frequency: 600,
    type: 'sine',
    duration: 0.08,
    attack: 0.005,
    decay: 0.075,
  },
  bell: {
    kind: 'oscillator',
    frequency: 523,
    type: 'triangle',
    duration: 0.4,
    attack: 0.01,
    decay: 0.39,
  },
  subtle: {
    kind: 'oscillator',
    frequency: 440,
    type: 'sine',
    duration: 0.1,
    attack: 0.02,
    decay: 0.08,
  },
  bruh: { kind: 'file', path: '/sounds/bruh.mp3' },
};

/** Audio context singleton */
let audioContext: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!audioContext) {
    audioContext = new AudioContext();
  }
  return audioContext;
}

/** Cache for file-based preset audio elements */
const presetAudioCache = new Map<string, HTMLAudioElement>();

/**
 * Play a preset sound (oscillator-based or file-based)
 */
export function playPresetSound(preset: PresetSound): void {
  try {
    const config = PRESET_SOUNDS[preset];

    if (config.kind === 'file') {
      // File-based preset
      let audio = presetAudioCache.get(config.path);
      if (!audio) {
        audio = new Audio(config.path);
        presetAudioCache.set(config.path, audio);
      }
      audio.currentTime = 0;
      void audio.play();
    } else {
      // Oscillator-based preset
      const ctx = getAudioContext();

      const oscillator = ctx.createOscillator();
      const gainNode = ctx.createGain();

      oscillator.connect(gainNode);
      gainNode.connect(ctx.destination);

      oscillator.frequency.value = config.frequency;
      oscillator.type = config.type;

      // Envelope
      gainNode.gain.setValueAtTime(0, ctx.currentTime);
      gainNode.gain.linearRampToValueAtTime(0.3, ctx.currentTime + config.attack);
      gainNode.gain.linearRampToValueAtTime(0, ctx.currentTime + config.duration);

      oscillator.start(ctx.currentTime);
      oscillator.stop(ctx.currentTime + config.duration);
    }
  } catch (err) {
    console.warn('Failed to play preset sound:', err);
  }
}

/** Cache for custom audio elements */
const customAudioCache = new Map<string, HTMLAudioElement>();

/**
 * Play a custom sound from a data URL
 * Returns true if successful, false otherwise (should fallback)
 */
export async function playCustomSound(dataUrl: string): Promise<boolean> {
  try {
    if (!dataUrl) {
      console.warn('No custom sound data URL provided');
      return false;
    }

    // Get or create audio element from cache
    let audio = customAudioCache.get(dataUrl);
    if (!audio) {
      audio = new Audio(dataUrl);
      customAudioCache.set(dataUrl, audio);
    }

    // Reset and play
    audio.currentTime = 0;
    await audio.play();
    return true;
  } catch (err) {
    console.warn('Failed to play custom sound:', err);
    return false;
  }
}

/**
 * Play a sound based on config, with fallback to preset if custom fails
 */
export async function playSound(config: SoundConfig): Promise<void> {
  if (config.type === 'custom' && config.customDataUrl) {
    const success = await playCustomSound(config.customDataUrl);
    if (!success) {
      // Fallback to default preset
      playPresetSound('ding');
    }
  } else if (config.type === 'preset' && config.preset) {
    playPresetSound(config.preset);
  }
}

/**
 * Load notification settings from localStorage
 */
export function loadNotificationSettings(): NotificationSettings {
  try {
    const stored = localStorage.getItem('notificationSettings');
    if (stored) {
      const parsed = JSON.parse(stored) as Partial<NotificationSettings>;
      return { ...DEFAULT_NOTIFICATION_SETTINGS, ...parsed };
    }
  } catch (err) {
    console.warn('Failed to load notification settings:', err);
  }
  return DEFAULT_NOTIFICATION_SETTINGS;
}

/**
 * Save notification settings to localStorage
 */
export function saveNotificationSettings(settings: NotificationSettings): void {
  try {
    localStorage.setItem('notificationSettings', JSON.stringify(settings));
  } catch (err) {
    console.warn('Failed to save notification settings:', err);
  }
}

/**
 * Get display name for a preset sound
 */
export function getPresetDisplayName(preset: PresetSound): string {
  const names: Record<PresetSound, string> = {
    ding: 'Ding',
    chime: 'Chime',
    pop: 'Pop',
    bell: 'Bell',
    subtle: 'Subtle',
    bruh: 'Bruh',
  };
  return names[preset];
}

/** All available preset sounds */
export const ALL_PRESETS: PresetSound[] = ['ding', 'chime', 'pop', 'bell', 'subtle', 'bruh'];
