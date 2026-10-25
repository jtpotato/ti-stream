import { useEffect, useRef, useState } from "react";
import { NspireCx2, type Screenshot } from "./nspire/device";

type Status = "idle" | "connecting" | "streaming" | "error";

export default function App() {
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [frames, setFrames] = useState(0);
  const [fps, setFps] = useState(0);
  const [size, setSize] = useState<string>("");
  const [isTheaterMode, setIsTheaterMode] = useState(false);
  const sizeRef = useRef("");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const calcRef = useRef<NspireCx2 | null>(null);
  const runRef = useRef(false);

  useEffect(() => {
    const release = () => {
      runRef.current = false;
      void calcRef.current?.close();
      calcRef.current = null;
    };
    window.addEventListener("pagehide", release);
    return () => {
      window.removeEventListener("pagehide", release);
      release();
    };
  }, []);

  function paint(shot: Screenshot) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (canvas.width !== shot.width || canvas.height !== shot.height) {
      canvas.width = shot.width;
      canvas.height = shot.height;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.putImageData(
      new ImageData(shot.rgba, shot.width, shot.height),
      0,
      0,
    );
    const nextSize = `${shot.width}×${shot.height} ${shot.bpp}bpp`;
    if (sizeRef.current !== nextSize) {
      sizeRef.current = nextSize;
      setSize(nextSize);
    }
  }

  async function connect() {
    setError(null);
    setStatus("connecting");
    try {
      const calc = await NspireCx2.request();
      calcRef.current = calc;
      runRef.current = true;
      setStatus("streaming");
      setFrames(0);
      setFps(0);
      let measuredFrames = 0;
      let measuredAt = performance.now();
      void (async () => {
        try {
          await calc.stream((shot) => {
            if (!runRef.current) return;
            paint(shot);
            measuredFrames += 1;
            const now = performance.now();
            if (now - measuredAt >= 1000) {
              setFrames((n) => n + measuredFrames);
              setFps(measuredFrames / ((now - measuredAt) / 1000));
              measuredFrames = 0;
              measuredAt = now;
            }
          });
        } catch (e) {
          if (!runRef.current) return;
          setStatus("error");
          setError(e instanceof Error ? e.message : String(e));
          runRef.current = false;
          calcRef.current = null;
        }
      })();
    } catch (e) {
      setStatus("error");
      const msg = e instanceof Error ? e.message : String(e);
      setError(
        /claim|open|access|busy|already/i.test(msg)
          ? `${msg} Close other TI software, unplug the calculator, then plug it back in.`
          : msg,
      );
    }
  }

  async function disconnect() {
    runRef.current = false;
    const calc = calcRef.current;
    calcRef.current = null;
    setStatus("idle");
    await calc?.close();
  }

  const usbOk = typeof navigator !== "undefined" && Boolean(navigator.usb);

  return (
    <main className={isTheaterMode ? "theater-mode" : undefined}>
      <header>
        <h1>TI-Nspire stream</h1>
        <p className="sub">View the CX II CAS over WebUSB. Good for screen recording. Requires a WebUSB-compatible browser (e.g. Chrome or Edge)</p>
      </header>

      {!usbOk && (
        <p className="banner">
          This browser has no WebUSB. Open this page in Chrome or Edge.
        </p>
      )}

      <div className="row">
        {status === "streaming" ? (
          <button type="button" onClick={() => void disconnect()}>
            Disconnect
          </button>
        ) : (
          <button type="button" onClick={() => void connect()} disabled={!usbOk || status === "connecting"}>
            {status === "connecting" ? "Connecting…" : "Connect calculator"}
          </button>
        )}
        <span className="meta">
          {status}
          {size ? ` · ${size}` : ""}
          {frames ? ` · ${frames} frames` : ""}
          {fps ? ` · ${fps.toFixed(1)} fps` : ""}
        </span>
        <button
          type="button"
          className="theater-button"
          onClick={() => setIsTheaterMode((active) => !active)}
          aria-pressed={isTheaterMode}
          title="Expand the video within this window"
        >
          {isTheaterMode ? "Exit theater mode" : "Theater mode"}
        </button>
      </div>

      {error && <p className="error">{error}</p>}

      <div className="screen">
        <canvas ref={canvasRef} width={320} height={240} />
      </div>
    </main>
  );
}
