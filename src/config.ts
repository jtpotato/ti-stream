/**
 * Milliseconds between screenshot requests. The calc is polled at this rate
 * and each completed frame is displayed, so this sets the maximum frame rate.
 * Lower = smoother but more load on the calc; 1000 ms is a safe default.
 */
export const SCREENSHOT_INTERVAL_MS = 1000;

export const TI_VID = 0x0451;
export const NSP_PID = 0xe012;
export const NSP_PID_CX2 = 0xe022;
