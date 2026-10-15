import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { AccessibilityInfo, Animated, Easing, Pressable, type PressableProps } from "react-native";

const ReducedMotion = createContext(true);

/** One subscription for all mobile motion; unknown accessibility state defaults to still. */
export function MotionProvider({ children }: { children: ReactNode }) {
	const [reduced, setReduced] = useState(true);
	useEffect(() => {
		let alive = true;
		let changed = false;
		const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", (value) => {
			changed = true;
			setReduced(value);
		});
		void AccessibilityInfo.isReduceMotionEnabled()
			.then((value) => {
				if (alive && !changed) setReduced(value);
			})
			.catch(() => undefined);
		return () => {
			alive = false;
			subscription.remove();
		};
	}, []);
	return <ReducedMotion.Provider value={reduced}>{children}</ReducedMotion.Provider>;
}

export function useReducedMotion() {
	return useContext(ReducedMotion);
}

/** Animate a page entry without remounting its stream or restarting on token updates. */
export function PageTransition({ identity, children }: { identity: string; children: ReactNode }) {
	const reduced = useReducedMotion();
	const progress = useRef(new Animated.Value(1)).current;
	useEffect(() => {
		progress.setValue(reduced ? 1 : 0);
		const animation = Animated.timing(progress, { toValue: 1, duration: 180, easing: Easing.out(Easing.cubic), useNativeDriver: true, isInteraction: false });
		if (!reduced) animation.start();
		return () => animation.stop();
	}, [identity, reduced, progress]);
	// Keep a concrete, untransformed native parent for Android's scrolling/clipping math.
	return (
		<Animated.View collapsable={false} style={{ flex: 1, opacity: progress }}>
			{children}
		</Animated.View>
	);
}

/** Immediate native press feedback also covers rows that lack custom pressed styles. */
export function Touch({ android_ripple, style, ...props }: PressableProps) {
	const reduced = useReducedMotion();
	return <Pressable android_ripple={reduced ? undefined : (android_ripple ?? { color: "#80808025" })} style={(state) => [typeof style === "function" ? style(state) : style, state.pressed && !props.disabled ? { opacity: 0.72 } : undefined]} {...props} />;
}
