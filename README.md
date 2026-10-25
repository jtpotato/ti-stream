# ti-stream

Streams whatever's on your TI NSpire CX II CAS to the browser window, where you can screen capture or project it somewhere else.

Use **Theater mode** to expand the stream within the current browser window and
compact the surrounding controls for screen sharing. Select **Exit theater
mode** to return to the normal layout.

Written mostly with a few coding agents over an hour and a bit.

## Performance

The screenshot request period is configured in
[`src/config.ts`](./src/config.ts). It is currently 200 ms, so the request
side is capped at 5 frames per second. The calculator, USB transfer size,
RLE encoding time, browser scheduling, and canvas upload determine the actual
rate; the UI reports the completed-frame rate while connected.

The previous reliability changes are intentional: capture has a continuous
reader, serialized USB writes, packet checksum/padding handling, and
reconnect-on-total-silence. A lost frame is discarded when the next header
arrives rather than blocking the stream. The stream backlog is bounded, frame
dimensions are capped before allocation, and the canvas path avoids copying
RGBA data a second time.

For a CX II at the documented 320×240 RGB565 format, 5 fps is a reasonable
upper target for this implementation. Sustained rates above that require
on-device testing; the screenshot service and encoding work, not USB bulk
bandwidth, are likely to be the limiting factors. Reduce the interval toward
100 ms only if the displayed FPS rises without increasing reconnects or
partial-frame drops.