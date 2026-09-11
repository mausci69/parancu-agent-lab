// Minimal TFJS initialisation for React Native (Expo).
// British English comments.

import "@tensorflow/tfjs-react-native";
import * as tf from "@tensorflow/tfjs";

let initialised = false;
let initPromise: Promise<void> | null = null;

/**
 * Initialise TensorFlow.js once. Prefer RN WebGL if available, else CPU.
 */
export async function initTF(opts: { preferCPU?: boolean } = {}): Promise<void> {
  const { preferCPU = false } = opts;
  if (initialised) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      await tf.setBackend(preferCPU ? "cpu" : "rn-webgl");
    } catch {
      await tf.setBackend("cpu");
    }
    await tf.ready();
    initialised = true;
  })();

  return initPromise;
}

/** Access the tf namespace if needed by callers. */
export function getTF() {
  return tf;
}

/** Quick diagnostics to show backend and version. */
export function tfInfo() {
  return { backend: tf.getBackend(), version: tf.version_core };
}

