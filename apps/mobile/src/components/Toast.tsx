import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { Animated, Easing, StyleSheet, Text, View } from "react-native";

type ToastKind = "info" | "success" | "error";

type ToastMessage = {
  id: number;
  text: string;
  kind: ToastKind;
  durationMs?: number;
};

type ToastContextValue = {
  show: (text: string, kind?: ToastKind, durationMs?: number) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within <ToastProvider />");
  return ctx;
}

export const ToastProvider: React.FC<React.PropsWithChildren> = ({ children }) => {
  const [current, setCurrent] = useState<ToastMessage | null>(null);
  const queue = useRef<ToastMessage[]>([]);
  const anim = useRef(new Animated.Value(0)).current;
  const idRef = useRef(1);

  const runNext = useCallback(() => {
    const next = queue.current.shift() || null;
    if (!next) {
      // Hide
      Animated.timing(anim, { toValue: 0, duration: 160, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
      setCurrent(null);
      return;
    }
    setCurrent(next);
    // Show
    Animated.timing(anim, { toValue: 1, duration: 160, easing: Easing.out(Easing.quad), useNativeDriver: true }).start(() => {
      const stay = next.durationMs ?? 2200;
      setTimeout(() => {
        // Hide then proceed
        Animated.timing(anim, { toValue: 0, duration: 160, easing: Easing.in(Easing.quad), useNativeDriver: true }).start(() => {
          setCurrent(null);
          runNext();
        });
      }, stay);
    });
  }, [anim]);

  const show = useCallback((text: string, kind: ToastKind = "info", durationMs?: number) => {
    queue.current.push({ id: idRef.current++, text, kind, durationMs });
    if (!current) runNext();
  }, [current, runNext]);

  const value = useMemo<ToastContextValue>(() => ({ show }), [show]);

  const translateY = anim.interpolate({ inputRange: [0, 1], outputRange: [20, 0] });
  const opacity = anim;

  return (
    <ToastContext.Provider value={value}>
      <View style={{ flex: 1 }}>
        {children}
        {/* Bottom overlay container */}
        <View pointerEvents="none" style={styles.overlay}>
          {current && (
            <Animated.View
              style={[
                styles.toast,
                styles[current.kind],
                { opacity, transform: [{ translateY }] },
              ]}
            >
              <Text style={styles.text}>{current.text}</Text>
            </Animated.View>
          )}
        </View>
      </View>
    </ToastContext.Provider>
  );
};

const styles = StyleSheet.create({
  overlay: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 24,
    alignItems: "center",
    paddingHorizontal: 16,
  },
  toast: {
    maxWidth: "94%",
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 14,
    shadowColor: "#000",
    shadowOpacity: 0.15,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 3,
  },
  info: { backgroundColor: "#2d6cdf" },
  success: { backgroundColor: "#2e7d32" },
  error: { backgroundColor: "#c62828" },
  text: { color: "white", fontSize: 14, fontWeight: "600" },
});

export default ToastProvider;

