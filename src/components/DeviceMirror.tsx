/**
 * DeviceMirror — live, interactive iOS Simulator preview.
 *
 * A **thin view** over a backend-owned mobile preview session. On mount it asks
 * the backend to {@link startMobilePreview} (which boots a sim if needed, starts
 * a serve-sim mirror, and reserves a port), embeds the MJPEG stream, and forwards
 * pointer events as normalized touches over serve-sim's WebSocket. The app build
 * runs in an embedded interactive {@link BuildTerminal}.
 *
 * Crucially, **unmounting tears down nothing native** — the simulator, the
 * serve-sim daemon, and the build all outlive this component. The backend owns
 * their lifecycle and tears them down on project suspend / close / window close.
 * That's what lets a multi-minute build survive a tab switch. This is the mobile
 * counterpart to {@link Preview}.
 *
 * See docs/mobile-app-preview-plan.md (§10c) and docs/mobile-app-preview-status.md.
 *
 * @module components/DeviceMirror
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { logger } from '../lib/logger';
import {
  startMobilePreview,
  getSimulatorLaunchCommand,
  connectInputChannel,
  buildSessionId,
  classifyBuildOutput,
  simulatorAppRunning,
  androidAppRunning,
  hideSimulator,
  detectMobileTargets,
  type MirrorInfo,
  type Platform,
  type MobileTargets,
} from '../lib/mobile';
import { usePolling } from '../hooks/usePolling';
import { checkDependenciesInstalled } from '../lib/project';
import { attachPtySession, writePtySession } from '../lib/ptySession';
import { getWindowLabel } from '../lib/window';
import { SpinnerIcon, ResetIcon, ChevronIcon } from './icons';
import { Button } from './primitives/Button';
import { BuildTerminal } from './BuildTerminal';
import { AndroidMirrorStage } from './AndroidMirrorStage';

interface DeviceMirrorProps {
  /** Project name, for guidance copy. */
  projectName: string;
  /** Absolute project path — used to start/key the backend preview session. */
  projectPath: string;
  /** Hand a prompt to the embedded Claude agent (powers "Fix with AI"). */
  onSendToAgent?: (text: string) => void;
}

type InputChannel = ReturnType<typeof connectInputChannel>;
type Status = 'starting' | 'connected' | 'error';
/**
 * App-build progress, shown on the build panel's summary under the mirror.
 * - `building` — running, no verdict yet (the default while compiling)
 * - `launched` — compiled and the app is up on the simulator (success steady state)
 * - `failed`   — a hard build failure (marker matched, or non-zero exit)
 * - `exited`   — the build process ended cleanly without launching (unusual)
 */
type LaunchStatus = 'none' | 'building' | 'launched' | 'failed' | 'exited' | 'unsupported';

/** Cap on the build log we keep in memory for outcome classification. Markers
 *  (BUILD SUCCEEDED / FAILED) land near the end of a build, so keeping the tail
 *  is sufficient and bounds memory on a long, chatty build. */
const BUILD_LOG_SCAN_CAP = 262144;

/** Pull the app's bundle id out of the build log (Expo prints
 *  `› Opening on iPhone 17 Pro (com.anonymous.my-app)`). Lets the simulator poll
 *  match our exact app instead of "any third-party app". */
const BUNDLE_ID_RE = /Opening on .*?\(([A-Za-z0-9.-]+)\)/;

/** Pull the Android applicationId from the build log. `run-android` / `run:android`
 *  launch via `am start`, which logs `Starting: Intent { … cmp=com.x/.MainActivity }`.
 *  Lets the emulator poll match our exact app. */
const ANDROID_APP_ID_RE = /cmp=([A-Za-z0-9_.]+)\//;

/** The app id (bundle id / applicationId) for the launch poll, parsed per platform. */
function appIdFromLog(platform: Platform, log: string): string | undefined {
  return (platform === 'android' ? log.match(ANDROID_APP_ID_RE) : log.match(BUNDLE_ID_RE))?.[1];
}

/** Per-platform UI copy so one component serves both without scattered ternaries. */
const PLATFORM_COPY: Record<Platform, { device: string; surface: string; startHint: string }> = {
  ios: {
    device: 'iOS Simulator',
    surface: 'simulator',
    startHint: 'Starting the iOS preview… (first boot can take ~30s)',
  },
  android: {
    device: 'Android Emulator',
    surface: 'emulator',
    startHint: 'Starting the Android preview… (first boot can take ~30s)',
  },
};

/** Auto-heal budget for a dropped mirror: reconnect with exponential backoff,
 *  then give up to the error view rather than looping forever. The budget resets
 *  once the stream is healthy again (a frame loads, or it stays connected for
 *  HEAL_STABLE_MS), so isolated blips over a long session don't exhaust it. */
const MAX_HEAL_ATTEMPTS = 3;
const HEAL_BASE_DELAY_MS = 1500;
const HEAL_STABLE_MS = 5000;

export function DeviceMirror({ projectName, projectPath, onSendToAgent }: DeviceMirrorProps) {
  // Which platforms the project can target, and which one we're previewing. Platform
  // starts null until detection resolves, so the first connect targets a platform the
  // project actually builds for (an Android-only project shouldn't try iOS first).
  const [targets, setTargets] = useState<MobileTargets | null>(null);
  const [platform, setPlatform] = useState<Platform | null>(null);

  const [status, setStatus] = useState<Status>('starting');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [mirror, setMirror] = useState<MirrorInfo | null>(null);
  const [launchStatus, setLaunchStatus] = useState<LaunchStatus>('none');
  const [buildCommand, setBuildCommand] = useState<string | null>(null);
  const [buildOpen, setBuildOpen] = useState(true);
  const [needsInstall, setNeedsInstall] = useState(false);
  // Whether the build command is still running. Expo (`expo run:ios`) and Flutter
  // (`flutter run`) stay attached to their bundler, so 'r' reloads work and the
  // process never exits. Bare RN (`react-native run-ios`) exits after launching —
  // Metro runs detached — so reload-via-PTY is impossible and the clean exit must
  // not be mistaken for a failed/ended preview.
  const [buildAlive, setBuildAlive] = useState(false);

  const inputRef = useRef<InputChannel | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const isPointerDown = useRef(false);
  // Auto-heal retry budget — declared up here (not next to the heal callbacks)
  // because the connect effect's stable-timer closes over it; a forward reference
  // would also trip the react-hooks immutability rule.
  const healAttemptsRef = useRef(0);

  // Accumulated build-log tail + a mirror of launchStatus, both read inside the
  // output handler (which must stay identity-stable so BuildTerminal's setup
  // effect doesn't re-run). The ref avoids stale-closure reads of launchStatus.
  const buildTextRef = useRef('');
  const launchStatusRef = useRef<LaunchStatus>('none');
  useEffect(() => {
    launchStatusRef.current = launchStatus;
  }, [launchStatus]);

  // Bump to re-run the connect flow (Restart / Try again).
  const [attempt, setAttempt] = useState(0);

  // Detect the project's build targets once, and pick the initial platform —
  // prefer iOS when available (the dev machine has Xcode), else Android. The picker
  // (shown only when both are targetable) lets the user switch from here.
  useEffect(() => {
    let cancelled = false;
    void detectMobileTargets(projectPath)
      .then((t) => {
        if (cancelled) return;
        setTargets(t);
        setPlatform((prev) => prev ?? (t.ios ? 'ios' : 'android'));
      })
      .catch(() => {
        // Detection failed (non-mobile or read error) — default to iOS so the
        // connect flow can still surface a clear tooling error.
        if (!cancelled) setPlatform((prev) => prev ?? 'ios');
      });
    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  // Connect flow: start the backend session → embed stream → wire input →
  // auto-launch the build. Each run owns a local `cancelled` flag so React
  // StrictMode's dev double-mount (and any real unmount/retry) only closes THIS
  // run's WebSocket — it never tears down the backend session (the backend owns
  // that lifecycle), so the mirror + build survive tab switches.
  useEffect(() => {
    let cancelled = false;
    let channel: InputChannel | null = null;
    let stableTimer: number | null = null;

    const resolveBuild = async (activePlatform: Platform, udid: string) => {
      let cmd: string;
      try {
        cmd = await getSimulatorLaunchCommand(projectPath, activePlatform, udid);
      } catch {
        if (!cancelled) setLaunchStatus('unsupported');
        return;
      }
      if (cancelled) return;
      // Soft signal only — an interactive terminal can surface/answer a missing
      // install, so we hint rather than block the launch (unlike the old gate).
      try {
        const dep = await checkDependenciesInstalled(projectPath);
        if (!cancelled && dep.hasPackageJson && !dep.installed) setNeedsInstall(true);
      } catch {
        /* dep check is best-effort */
      }
      if (cancelled) return;
      buildTextRef.current = '';
      setBuildCommand(cmd);
      setBuildOpen(true);
      setBuildAlive(true);
      setLaunchStatus('building');
    };

    const run = async () => {
      // Wait for platform detection before the first connect (see the detect effect).
      if (cancelled || !platform) return;
      setErrorMsg(null);
      setStatus('starting');
      setLaunchStatus('none');
      setBuildCommand(null);
      setNeedsInstall(false);
      setBuildAlive(false);
      try {
        logger.info('[DeviceMirror] starting backend mobile preview', { platform });
        const info = await startMobilePreview(projectPath, getWindowLabel(), platform);
        if (cancelled) return;
        logger.info('[DeviceMirror] preview started', { stream: info.stream_url, platform });
        // iOS drives input over serve-sim's WebSocket from here; Android's canvas
        // stage owns its own socket (video + input), so no channel is wired here.
        if (platform === 'ios') {
          channel = connectInputChannel(info.ws_url);
          inputRef.current = channel;
        }
        setMirror(info);
        setStatus('connected');

        // Stayed connected this long → mirror is healthy; refill the heal budget
        // so blips spread across a long session don't exhaust it (and we don't
        // depend on the MJPEG <img> firing onLoad to reset it).
        stableTimer = window.setTimeout(() => {
          healAttemptsRef.current = 0;
        }, HEAL_STABLE_MS);

        // Auto-launch the app build into the embedded terminal.
        void resolveBuild(platform, info.udid);
      } catch (err) {
        if (cancelled) return;
        logger.error('[DeviceMirror] failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        setErrorMsg(err instanceof Error ? err.message : String(err));
        setStatus('error');
      }
    };
    // Deferred so the first setState lands outside the effect's sync body.
    void Promise.resolve().then(run);

    return () => {
      cancelled = true;
      isPointerDown.current = false;
      if (stableTimer !== null) clearTimeout(stableTimer);
      channel?.close();
      if (inputRef.current === channel) inputRef.current = null;
      // No native teardown here — the backend owns the session lifecycle.
    };
    // `platform` is a dep: switching it re-runs the connect flow, and the backend
    // tears down the previous platform's session before starting the new one.
  }, [attempt, projectPath, platform]);

  // Manual restart (button / "Try again") is a fresh user intent — refill the
  // heal budget so auto-heal gets its full allowance again.
  const restart = useCallback(() => {
    healAttemptsRef.current = 0;
    setAttempt((a) => a + 1);
  }, []);

  // Switch the previewed platform. Changing `platform` re-runs the connect effect,
  // and the backend tears down the previous platform's session first. No-op if it's
  // already the active platform (avoids a needless teardown/reboot).
  const switchPlatform = useCallback((next: Platform) => {
    healAttemptsRef.current = 0;
    setPlatform((prev) => (prev === next ? prev : next));
  }, []);

  // Auto-heal: the MJPEG <img> fires onError when the stream drops (serve-sim
  // died). Rather than freeze on the last frame until the user clicks Restart, we
  // reconnect — which re-runs startMobilePreview and the backend respawns the dead
  // mirror. Bounded: exponential backoff and a hard attempt cap, after which we
  // surface the error instead of looping (an unrecoverable sim would otherwise
  // re-trigger a boot every cycle). The budget refills once the mirror is healthy
  // again (onMirrorLoad, or HEAL_STABLE_MS connected — see the connect effect).
  const healTimerRef = useRef<number | null>(null);
  const cancelHeal = useCallback(() => {
    if (healTimerRef.current !== null) {
      clearTimeout(healTimerRef.current);
      healTimerRef.current = null;
    }
  }, []);
  const scheduleHeal = useCallback(() => {
    if (healTimerRef.current !== null) return; // a heal is already pending
    if (healAttemptsRef.current >= MAX_HEAL_ATTEMPTS) {
      // Mirror won't come back on its own — stop looping and let the user act.
      setErrorMsg('Lost the connection to the simulator mirror.');
      setStatus('error');
      return;
    }
    const delay = HEAL_BASE_DELAY_MS * 2 ** healAttemptsRef.current; // 1.5s, 3s, 6s
    healAttemptsRef.current += 1;
    healTimerRef.current = window.setTimeout(() => {
      healTimerRef.current = null;
      setAttempt((a) => a + 1); // reconnect; backend respawns the mirror
    }, delay);
  }, []);
  // A healthy frame means the stream recovered — drop any pending heal and refill
  // the budget so future blips get a fresh allowance.
  const onMirrorLoad = useCallback(() => {
    healAttemptsRef.current = 0;
    cancelHeal();
  }, [cancelHeal]);
  useEffect(() => cancelHeal, [cancelHeal]);

  // Reload the JS bundle without a full rebuild: Metro (`expo run:ios` /
  // `react-native run-ios`) and `flutter run` all reload on an 'r' keystroke. We
  // write it straight to the build PTY the app is running in.
  const reloadApp = useCallback(() => {
    void writePtySession(buildSessionId(projectPath), 'r');
  }, [projectPath]);

  // Settle the build verdict. 'launched' is ground truth — the app is actually on
  // the simulator — so it always wins, even over a prior 'failed'. That's what lets
  // an agent's out-of-band rebuild (which our BuildTerminal can't see) resolve a
  // failed panel to launched. Other verdicts settle only from the initial
  // 'building', so a torn-down Metro (which exits non-zero) can't flip a launched
  // app to 'failed', and a stale 'failed' stays put until the app genuinely comes up.
  const settleLaunchStatus = useCallback(
    (next: 'launched' | 'failed' | 'exited') => {
      if (launchStatusRef.current === 'launched') return;
      if (next !== 'launched' && launchStatusRef.current !== 'building') return;
      launchStatusRef.current = next;
      setLaunchStatus(next);
      if (next === 'launched') {
        setBuildOpen(false); // app is up — collapse the log
        // iOS only: the build tool foregrounded Simulator.app over Ship Studio; the
        // mirror is headless so the window is redundant — tuck it away. Android's
        // emulator window has no equivalent we hide. Best-effort.
        if (platform === 'ios') void hideSimulator();
      }
    },
    [platform]
  );

  // Ground-truth launch detection: poll the simulator for our actually-running app.
  // This is the authoritative "did it launch" signal and covers two gaps the
  // build-log classifier can't: (1) it misses some frameworks' success banners
  // (Expo's "iOS Bundled" / "Opening on …" aren't markers), and (2) it can't see a
  // build the agent ran in its OWN terminal after "Send to agent". So it resolves
  // both 'building' → 'launched' (normal build) and 'failed' → 'launched' (agent
  // rescue). We pass the bundle id parsed from the log when we have it, so a stale
  // app on a pre-booted sim can't cause a false launch. Enabled only while a verdict
  // is still pending; usePolling backs off on error (sim booting / mid-teardown).
  usePolling(
    async () => {
      const id = mirror?.udid; // iOS: sim udid · Android: emulator serial
      if (!id || !platform) return;
      const appId = appIdFromLog(platform, buildTextRef.current);
      const running =
        platform === 'android'
          ? await androidAppRunning(id, appId)
          : await simulatorAppRunning(id, appId);
      if (running) settleLaunchStatus('launched');
    },
    {
      intervalMs: 3000,
      // Include 'exited': bare RN's `run-ios` / `run-android` exit 0 right after
      // launching, so the app is up but the build process is gone — the poll is
      // what upgrades that clean exit to 'launched'.
      enabled:
        status === 'connected' &&
        (launchStatus === 'building' || launchStatus === 'failed' || launchStatus === 'exited'),
      name: 'mobile-app-running',
    }
  );

  // Classify build progress from the embedded terminal's output. A successful
  // `expo run:ios` / `flutter run` never exits (it stays attached to Metro), so
  // log markers — not the process exit — are how we know the app actually came
  // up. See classifyBuildOutput.
  //
  // Known limitation: the verdict lives only in this component. On a tab-return
  // the log is replayed from the pty's bounded ring buffer; for a long-lived
  // launched app whose success banner has scrolled out of the ring, the marker
  // is gone and the status can fall back to 'building'. The fix is a
  // backend-owned build status (persisted in MobileSession, returned from
  // start_mobile_preview) — the same signal the agent-assist loop will need.
  const handleBuildOutput = useCallback(
    (chunk: string) => {
      if (launchStatusRef.current !== 'building') return;
      buildTextRef.current = (buildTextRef.current + chunk).slice(-BUILD_LOG_SCAN_CAP);
      const outcome = classifyBuildOutput(buildTextRef.current);
      if (outcome) settleLaunchStatus(outcome);
    },
    [settleLaunchStatus]
  );

  // Process exit is the authoritative failure backstop: a build that died before
  // emitting a marker we recognize (e.g. a failed `pod install`) still resolves.
  const onBuildExit = useCallback(
    (exitCode: number) => {
      setBuildAlive(false); // bundler is gone — no reload-via-PTY past this point
      settleLaunchStatus(exitCode === 0 ? 'exited' : 'failed');
    },
    [settleLaunchStatus]
  );

  // Hand the failing build's output to the embedded agent so it can diagnose and
  // fix it — the whole point of Ship Studio is the agent does the heavy lifting,
  // so the user shouldn't have to read xcodebuild stack traces.
  const sendBuildToAgent = useCallback(async () => {
    let log = '';
    try {
      const attach = await attachPtySession(buildSessionId(projectPath));
      log = new TextDecoder().decode(attach.buffer).slice(-6000);
    } catch {
      /* best-effort — send the prompt even if we couldn't grab the log */
    }
    const surface = platform ? PLATFORM_COPY[platform].surface : 'simulator';
    const platformName = platform === 'android' ? 'Android' : 'iOS';
    const prompt =
      `The ${platformName} preview build for "${projectName}" failed. Diagnose the error in the build output below and fix it so the app builds and launches on the ${surface}, then tell me what you changed.\n\n` +
      (buildCommand ? `Build command: ${buildCommand}\n\n` : '') +
      'Build output:\n```\n' +
      (log || '(no build output captured)') +
      '\n```';
    onSendToAgent?.(prompt);
  }, [projectPath, projectName, buildCommand, onSendToAgent, platform]);

  // Map a pointer event to normalized 0..1 coords over the streamed image.
  const toNorm = (e: React.PointerEvent): { x: number; y: number } | null => {
    const el = imgRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const p = toNorm(e);
    if (!p) return;
    isPointerDown.current = true;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    inputRef.current?.sendTouch('down', p.x, p.y);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!isPointerDown.current) return;
    const p = toNorm(e);
    if (p) inputRef.current?.sendTouch('move', p.x, p.y);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (!isPointerDown.current) return;
    isPointerDown.current = false;
    const p = toNorm(e);
    if (p) inputRef.current?.sendTouch('up', p.x, p.y);
  };

  // ---- Connected: the live mirror ----
  if (status === 'connected' && mirror) {
    const activePlatform: Platform = platform ?? 'ios';
    const surface = PLATFORM_COPY[activePlatform].surface;
    // A successful `expo run` / `flutter run` stays attached to Metro and never
    // exits, so the verdict comes from log markers / the app-running poll, not the
    // process exit. 'launched' is the success steady state.
    const summary =
      launchStatus === 'building'
        ? 'Building & launching… your app appears in the preview above (first build can take a few minutes)'
        : launchStatus === 'launched'
          ? `App running on the ${surface}`
          : launchStatus === 'exited'
            ? 'Build process exited'
            : launchStatus === 'failed'
              ? 'Build failed — see log'
              : '';
    // The picker only appears when the project genuinely targets both platforms.
    const showPicker = !!targets?.ios && !!targets?.android;
    return (
      <div className="device-mirror">
        <div className="device-mirror-toolbar">
          {showPicker && (
            <div className="device-mirror-platform" role="group" aria-label="Preview platform">
              {(['ios', 'android'] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  className={`device-mirror-platform-btn${activePlatform === p ? ' active' : ''}`}
                  aria-pressed={activePlatform === p}
                  onClick={() => switchPlatform(p)}
                >
                  {p === 'ios' ? 'iOS' : 'Android'}
                </button>
              ))}
            </div>
          )}
          <span className="device-mirror-label">
            {mirror.device_name
              ? `${mirror.device_name}${mirror.device_runtime ? ` · ${mirror.device_runtime}` : ''} · live`
              : `${PLATFORM_COPY[activePlatform].device} · live`}
          </span>
          {launchStatus === 'launched' && buildAlive && (
            <Button variant="ghost" size="sm" onClick={reloadApp}>
              <ResetIcon size={14} /> Reload
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={restart}>
            <ResetIcon size={14} /> Restart
          </Button>
        </div>
        <div className="device-mirror-stage">
          {activePlatform === 'android' ? (
            // Key by attempt so a heal/Restart remounts the decoder even when the
            // backend hands back the same bridge port (wsUrl alone wouldn't change).
            <AndroidMirrorStage
              key={attempt}
              wsUrl={mirror.ws_url}
              onError={scheduleHeal}
              onFirstFrame={onMirrorLoad}
            />
          ) : (
            <img
              ref={imgRef}
              className="device-mirror-screen"
              src={mirror.stream_url}
              alt="iOS Simulator"
              draggable={false}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onError={scheduleHeal}
              onLoad={onMirrorLoad}
            />
          )}
        </div>
        {buildCommand && launchStatus !== 'unsupported' && (
          <div className={`device-mirror-build${buildOpen ? ' open' : ''}`}>
            <div className="device-mirror-build-header">
              <button
                type="button"
                className="device-mirror-build-toggle"
                data-state={launchStatus}
                onClick={() => setBuildOpen((o) => !o)}
                aria-expanded={buildOpen}
              >
                {launchStatus === 'building' && <SpinnerIcon size={12} />}
                <span className="device-mirror-build-title">{summary}</span>
              </button>
              {launchStatus === 'failed' && onSendToAgent && (
                <button
                  type="button"
                  className="device-mirror-build-send"
                  onClick={() => void sendBuildToAgent()}
                  title="Send the build error to the active agent"
                >
                  Send to agent
                </button>
              )}
              <button
                type="button"
                className={`device-mirror-build-chevron${buildOpen ? ' open' : ''}`}
                onClick={() => setBuildOpen((o) => !o)}
                aria-label={buildOpen ? 'Collapse build log' : 'Expand build log'}
              >
                <ChevronIcon size={14} />
              </button>
            </div>
            {needsInstall && (
              <p className="device-mirror-build-hint">
                Dependencies may not be installed — if the build fails, run <code>npm install</code>{' '}
                and Restart.
              </p>
            )}
            <div
              className="device-mirror-build-body"
              style={{ display: buildOpen ? 'flex' : 'none' }}
            >
              <BuildTerminal
                sessionId={buildSessionId(projectPath)}
                command={buildCommand}
                cwd={projectPath}
                isActive={buildOpen}
                onExit={onBuildExit}
                onOutput={handleBuildOutput}
              />
            </div>
          </div>
        )}
      </div>
    );
  }

  // ---- Error ----
  if (status === 'error') {
    const needsXcode = /xcrun|xcode|command line tools/i.test(errorMsg ?? '');
    // Android tooling gaps: no SDK/adb/emulator, or no AVD created yet.
    const needsAndroid = /\b(adb|emulator|android sdk|avd|virtual device)\b/i.test(errorMsg ?? '');
    const title = needsXcode
      ? 'iOS tooling unavailable'
      : needsAndroid
        ? 'Android tooling unavailable'
        : "Couldn't start the preview";
    const detail = needsXcode
      ? 'Previewing an iOS app needs Xcode command line tools. Install Xcode, then run xcode-select --install.'
      : needsAndroid
        ? 'Previewing an Android app needs the Android SDK and a Virtual Device. Install Android Studio, then create an emulator in Device Manager.'
        : `Ship Studio couldn't start a ${PLATFORM_COPY[platform ?? 'ios'].surface} preview for ${projectName}.`;
    return (
      <div className="preview-install-prompt">
        <h3>{title}</h3>
        <p className="hint">{detail}</p>
        {errorMsg && <p className="hint">{errorMsg}</p>}
        <Button variant="secondary" size="sm" onClick={restart}>
          <ResetIcon size={14} /> Try again
        </Button>
      </div>
    );
  }

  // ---- Progress (starting) ----
  return (
    <div className="preview-loading">
      <SpinnerIcon size={24} />
      <span className="hint">{PLATFORM_COPY[platform ?? 'ios'].startHint}</span>
    </div>
  );
}
